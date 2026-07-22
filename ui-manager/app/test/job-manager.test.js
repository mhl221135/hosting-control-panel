const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { JobManager } = require("../lib/job-manager");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-jobs-test-"));
  const manager = new JobManager({ dataDir: root, historyLimit: 25 });
  return { root, manager };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(check, timeout = 1000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for job state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("persists successful jobs without exposing private payloads", async () => {
  const context = fixture();
  try {
    context.manager.register("test.success", async (job, payload) => {
      job.update({ total: 1, completed: 1, currentStep: `Processed ${payload.domain}` });
      return { ok: true, total: 1, completed: 1, results: [{ domain: payload.domain, ok: true }] };
    });
    context.manager.start();
    const created = context.manager.create({
      type: "test.success",
      label: "Test success",
      targets: ["example.com"],
      payload: { domain: "example.com" },
    });
    assert.equal(created.payload, undefined);
    const finished = await context.manager.wait(created.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.completed, 1);
    const stored = JSON.parse(fs.readFileSync(path.join(context.root, "jobs.json"), "utf8"));
    assert.equal(stored.jobs[0].status, "succeeded");
    assert.throws(() => context.manager.create({
      type: "test.success",
      label: "Unsafe",
      payload: { apiToken: "must-not-persist" },
    }), /sensitive field/);
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("queues conflicting jobs and runs them sequentially", async () => {
  const context = fixture();
  const firstGate = deferred();
  const calls = [];
  try {
    context.manager.register("test.conflict", async (job, payload) => {
      calls.push(`start:${payload.name}`);
      if (payload.name === "first") await firstGate.promise;
      calls.push(`finish:${payload.name}`);
      return { ok: true };
    });
    context.manager.start();
    const first = context.manager.create({ type: "test.conflict", label: "First", conflicts: ["server-heavy"], payload: { name: "first" } });
    const second = context.manager.create({ type: "test.conflict", label: "Second", conflicts: ["server-heavy"], payload: { name: "second" } });
    await until(() => context.manager.get(first.id).status === "running");
    assert.equal(context.manager.get(second.id).status, "queued");
    assert.equal(context.manager.publicJob(context.manager.get(second.id)).waitingFor[0].id, first.id);
    firstGate.resolve();
    await Promise.all([context.manager.wait(first.id), context.manager.wait(second.id)]);
    assert.deepEqual(calls, ["start:first", "finish:first", "start:second", "finish:second"]);
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("cancels running work only when its handler reaches a checkpoint", async () => {
  const context = fixture();
  const gate = deferred();
  try {
    context.manager.register("test.cancel", async (job) => {
      job.update({ total: 2, completed: 1, currentStep: "Unsafe operation in progress" });
      await gate.promise;
      job.checkpoint("Stopped before the second operation");
      return { ok: true };
    });
    context.manager.start();
    const created = context.manager.create({ type: "test.cancel", label: "Cancelable", conflicts: ["server-heavy"], payload: {} });
    await until(() => context.manager.get(created.id).status === "running");
    const cancelling = context.manager.cancel(created.id);
    assert.equal(cancelling.status, "cancelling");
    gate.resolve();
    const finished = await context.manager.wait(created.id);
    assert.equal(finished.status, "cancelled");
    assert.equal(finished.completed, 1);
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("recovers interrupted jobs and preserves queued jobs after restart", async () => {
  const context = fixture();
  try {
    fs.writeFileSync(path.join(context.root, "jobs.json"), JSON.stringify({
      version: 1,
      jobs: [
        { id: "running", type: "test.restart", label: "Running", status: "running", createdAt: "2026-07-22T10:00:00Z", conflicts: [], payload: {} },
        { id: "queued", type: "test.restart", label: "Queued", status: "queued", createdAt: "2026-07-22T10:01:00Z", conflicts: [], payload: {}, targets: [] },
      ],
    }));
    const recovered = new JobManager({ dataDir: context.root });
    assert.equal(recovered.get("running").status, "failed");
    assert.match(recovered.get("running").error, /interrupted/);
    assert.equal(recovered.get("queued").status, "queued");
    recovered.register("test.restart", async () => ({ ok: true }));
    recovered.start();
    assert.equal((await recovered.wait("queued")).status, "succeeded");
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("records partial success and links retries to the failed attempt", async () => {
  const context = fixture();
  try {
    context.manager.register("test.partial", async () => ({
      ok: false,
      total: 2,
      completed: 2,
      results: [{ domain: "one.example", ok: true }, { domain: "two.example", ok: false, message: "failed" }],
    }));
    context.manager.start();
    const first = context.manager.create({ type: "test.partial", label: "Partial", payload: {}, total: 2 });
    assert.equal((await context.manager.wait(first.id)).status, "partially_succeeded");
    const retry = context.manager.retry(first.id, "operator@example.com");
    assert.equal(retry.retryOf, first.id);
    assert.equal(retry.attempt, 2);
    assert.equal(retry.operator, "operator@example.com");
    assert.equal((await context.manager.wait(retry.id)).status, "partially_succeeded");
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("deduplicates active submissions and reports a completed final step accurately", async () => {
  const context = fixture();
  const gate = deferred();
  let calls = 0;
  try {
    context.manager.register("test.deduplicate", async (job) => {
      calls += 1;
      job.update({ total: 1, completed: 0, currentStep: "Final non-interruptible step" });
      await gate.promise;
      job.update({ completed: 1 });
      return { ok: true, total: 1, completed: 1, message: "Operation completed" };
    });
    context.manager.start();
    const first = context.manager.create({
      type: "test.deduplicate",
      label: "Deduplicate",
      idempotencyKey: "same-operation",
      payload: {},
    });
    const duplicate = context.manager.create({
      type: "test.deduplicate",
      label: "Deduplicate",
      idempotencyKey: "same-operation",
      payload: {},
    });
    assert.equal(duplicate.id, first.id);
    await until(() => context.manager.get(first.id).status === "running");
    context.manager.cancel(first.id);
    gate.resolve();
    const finished = await context.manager.wait(first.id);
    assert.equal(calls, 1);
    assert.equal(finished.status, "succeeded");
    assert.match(finished.message, /after the final safe boundary/);
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("redacts command-line database and WordPress passwords from failed jobs", async () => {
  const context = fixture();
  try {
    context.manager.register("site.provision", async () => {
      throw new Error("Command failed --dbpass=db-secret --admin_password=wp-secret IDENTIFIED BY 'sql-secret'");
    });
    context.manager.start();
    const queued = context.manager.create({ type: "site.provision", payload: {} });
    const job = await context.manager.wait(queued.id);
    assert.equal(job.status, "failed");
    assert.equal(job.error.includes("db-secret"), false);
    assert.equal(job.error.includes("wp-secret"), false);
    assert.equal(job.error.includes("sql-secret"), false);
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});
