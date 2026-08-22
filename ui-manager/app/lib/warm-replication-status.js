const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const FOLDERS = ["hosting-websites", "hosting-runtime-config", "hosting-db-recovery"];

function boundedCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function folderView(id, value = {}) {
  return {
    id,
    state: ["idle", "scanning", "syncing", "scan-waiting", "sync-waiting"].includes(value.state)
      ? value.state : "unknown",
    globalFiles: boundedCount(value.globalFiles),
    localFiles: boundedCount(value.localFiles),
    needFiles: boundedCount(value.needFiles ?? value.needTotalItems),
    needBytes: boundedCount(value.needBytes),
    receiveOnlyItems: boundedCount(value.receiveOnlyTotalItems),
    errors: boundedCount(value.errors),
  };
}

function parseRecoveryManifest(value, now = Date.now()) {
  if (!value || value.version !== 1 || typeof value.createdAt !== "string") return null;
  const created = Date.parse(value.createdAt);
  if (!Number.isFinite(created) || created > now + 300_000) return null;
  return {
    id: String(value.id || "").slice(0, 64),
    createdAt: new Date(created).toISOString(),
    ageMinutes: Math.max(0, Math.floor((now - created) / 60_000)),
    size: boundedCount(value.size),
  };
}

class WarmReplicationStatus {
  constructor(options = {}) {
    this.execFile = options.execFile || execFileAsync;
    this.now = options.now || Date.now;
    this.recoveryRoot = options.recoveryRoot || "/srv/replication/database";
    this.expectedDeviceId = String(options.expectedDeviceId || "").trim().toUpperCase();
  }

  async dockerExec(args) {
    const { stdout } = await this.execFile("docker", ["exec", "hosting-sync", ...args], {
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return String(stdout || "").trim();
  }

  async api(path) {
    const script = 'key="$(sed -n "s:.*<apikey>\\(.*\\)</apikey>.*:\\1:p" /var/syncthing/config/config.xml)"; exec wget -qO- --header="X-API-Key: $key" "http://127.0.0.1:8384$1"';
    return JSON.parse(await this.dockerExec(["sh", "-c", script, "sh", path]));
  }

  async read() {
    const checkedAt = new Date(this.now()).toISOString();
    try {
      const [connections, ...rawFolders] = await Promise.all([
        this.api("/rest/system/connections"),
        ...FOLDERS.map((id) => this.api(`/rest/db/status?folder=${id}`)),
      ]);
      const connectionMap = connections.connections || {};
      const peers = Object.values(connectionMap);
      const expectedPeer = this.expectedDeviceId ? connectionMap[this.expectedDeviceId] : null;
      const folders = FOLDERS.map((id, index) => folderView(id, rawFolders[index]));
      let recovery = null;
      try {
        const entries = fs.readdirSync(this.recoveryRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(entry.name))
          .map((entry) => entry.name).sort();
        const latest = entries.at(-1);
        if (latest) recovery = parseRecoveryManifest(
          JSON.parse(fs.readFileSync(path.join(this.recoveryRoot, latest, "manifest.json"), "utf8")), this.now(),
        );
      } catch {}
      return {
        available: true,
        checkedAt,
        peerIdentityConfigured: Boolean(this.expectedDeviceId),
        peerConnected: this.expectedDeviceId
          ? expectedPeer?.connected === true
          : peers.some((peer) => peer?.connected === true),
        folders,
        exact: folders.every((folder) => folder.state === "idle" && folder.needFiles === 0
          && folder.receiveOnlyItems === 0 && folder.errors === 0),
        recovery,
      };
    } catch (error) {
      return { available: false, checkedAt, peerIdentityConfigured: Boolean(this.expectedDeviceId),
        peerConnected: false, folders: [], exact: false, recovery: null,
        error: String(error.message || "Replication status unavailable").slice(0, 180) };
    }
  }
}

module.exports = { FOLDERS, WarmReplicationStatus, folderView, parseRecoveryManifest };
