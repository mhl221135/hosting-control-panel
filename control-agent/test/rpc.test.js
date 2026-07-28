const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const TOKEN = crypto.randomBytes(32).toString("hex");
const PORT = 18791;

function waitForHealth() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      const request = http.get(`http://127.0.0.1:${PORT}/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else retry();
      });
      request.on("error", retry);
    };
    const retry = () => {
      if (Date.now() - started > 5_000) reject(new Error("Agent did not start"));
      else setTimeout(attempt, 25);
    };
    attempt();
  });
}

function runClient(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, "../../ui-manager/docker-rpc.js"), ...args], {
      env: {
        ...process.env,
        HOSTING_AGENT_TOKEN: TOKEN,
        HOSTING_AGENT_URL: `http://127.0.0.1:${PORT}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input || "");
  });
}

test("RPC shim streams allowed commands and rejects Docker host control", { timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-agent-rpc-"));
  const executable = path.join(directory, "docker");
  fs.writeFileSync(executable, [
    "#!/bin/sh",
    "printf 'args:%s\\n' \"$*\"",
    "cat",
  ].join("\n"), { mode: 0o755 });
  const agent = spawn(process.execPath, [path.resolve(__dirname, "../app/server.js")], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      PORT: String(PORT),
      HOSTING_AGENT_TOKEN: TOKEN,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    await waitForHealth();
    const allowed = await runClient(["exec", "hosting-nginx", "nginx", "-t"], { input: "streamed-input" });
    assert.equal(allowed.code, 0);
    assert.match(allowed.stdout, /hosting-nginx nginx -t/);
    assert.match(allowed.stdout, /streamed-input/);

    const rejected = await runClient(["run", "--privileged", "-v", "/:/host", "alpine"]);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /not allowed/);
  } finally {
    agent.kill("SIGTERM");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
