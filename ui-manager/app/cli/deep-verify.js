#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { DeepVerifyManager } = require("../lib/deep-verify-manager");

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
      process.stdout.write(`${completed}/${total}${current ? ` ${current}` : ""}\n`);
    },
  };
  const result = await manager.runDeepVerify(context);
  process.stdout.write(`${result.completed}/${result.total} ${result.message}\n`);
}

main().catch((error) => fail(error?.message || error));
