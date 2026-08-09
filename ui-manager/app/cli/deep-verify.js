#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { DeepVerifyManager } = require("../lib/deep-verify-manager");
const { atomicWriteJson } = require("../lib/safe-write");

function fail(message) {
  process.stderr.write(`${String(message || "Deep verification failed").replace(/[\r\n\t]+/g, " ").slice(0, 500)}\n`);
  process.exitCode = 1;
}

function standbyRole(markerPath) {
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  return marker?.version === 1 && marker?.role === "standby";
}

async function main() {
  const backupsRoot = path.resolve(process.argv[2] || process.env.BACKUPS_ROOT || "/srv/backups");
  const progressPath = path.join(backupsRoot, "deep-verify-progress.json");
  const markerPath = process.env.INSTALLATION_ROLE_MARKER || "/run/hosting-machine/role.json";
  if (!standbyRole(markerPath)) throw new Error("Deep verification CLI is restricted to a machine-local standby role");
  if (!fs.statSync(backupsRoot).isDirectory()) throw new Error("Backup root is unavailable");

  let cancelled = false;
  process.once("SIGINT", () => { cancelled = true; });
  process.once("SIGTERM", () => { cancelled = true; });
  const manager = new DeepVerifyManager({
    backupsRoot,
    jobManager: { register() {} },
  });
  const progressState = { completed: 0, total: 0, currentStep: "" };
  const startedAt = new Date().toISOString();
  const writeProgress = (status, error = "") => atomicWriteJson(progressPath, {
    version: 1,
    status,
    startedAt,
    finishedAt: status === "running" ? "" : new Date().toISOString(),
    completed: Math.max(0, Number(progressState.completed || 0)),
    total: Math.max(0, Number(progressState.total || 0)),
    currentStep: String(progressState.currentStep || "").replace(/[\r\n\t]+/g, " ").slice(0, 200),
    error: String(error || "").replace(/[\r\n\t]+/g, " ").slice(0, 300),
  }, 0o600);
  writeProgress("running");
  const context = {
    cancellationRequested: () => cancelled,
    checkpoint: () => {
      if (cancelled) {
        const error = new Error("Deep verification cancelled");
        error.name = "JobCancelledError";
        throw error;
      }
    },
    update: (progress = {}) => {
      Object.assign(progressState, progress);
      const completed = Math.max(0, Number(progressState.completed || 0));
      const total = Math.max(0, Number(progressState.total || 0));
      const current = String(progressState.currentStep || "").replace(/[\r\n\t]+/g, " ").slice(0, 200);
      writeProgress("running");
      process.stdout.write(`${completed}/${total}${current ? ` ${current}` : ""}\n`);
    },
  };
  try {
    const result = await manager.runDeepVerify(context);
    Object.assign(progressState, { completed: result.completed, total: result.total, currentStep: result.message });
    writeProgress("succeeded");
    process.stdout.write(`${result.completed}/${result.total} ${result.message}\n`);
  } catch (error) {
    writeProgress("failed", error?.message || error);
    throw error;
  }
}

main().catch((error) => fail(error?.message || error));
