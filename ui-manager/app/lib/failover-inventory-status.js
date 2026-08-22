const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function readHostFile(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error("Unsafe hostname inventory");
  const values = fs.readFileSync(filename, "utf8").split(/\r?\n/).filter(Boolean);
  if (!values.length || values.length > 5000 || values.some((value) => !HOSTNAME.test(value))) {
    throw new Error("Invalid hostname inventory");
  }
  if (new Set(values).size !== values.length || values.some((value, index) => index && value <= values[index - 1])) {
    throw new Error("Hostname inventory must be sorted and unique");
  }
  return values;
}

function readFailoverInventoryStatus(machineStateDir) {
  try {
    const candidatePath = path.join(machineStateDir, "failover-hosts.candidates.txt");
    const metadataPath = path.join(machineStateDir, "failover-hosts.candidates.json");
    const activePaths = ["failover-hosts.auto.txt", "failover-hosts.txt"].map((name) => path.join(machineStateDir, name));
    const activePath = activePaths.find((filename) => fs.existsSync(filename));
    if (!activePath) throw new Error("Active failover inventory is missing");
    const candidates = readHostFile(candidatePath);
    const active = readHostFile(activePath);
    const metadataStat = fs.lstatSync(metadataPath);
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 4096) throw new Error("Unsafe inventory metadata");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const checksum = crypto.createHash("sha256").update(fs.readFileSync(candidatePath)).digest("hex");
    if (metadata.version !== 1 || metadata.count !== candidates.length || metadata.sha256 !== checksum) {
      throw new Error("Candidate inventory metadata does not match");
    }
    const activeSet = new Set(active);
    const candidateSet = new Set(candidates);
    const additions = candidates.filter((hostname) => !activeSet.has(hostname));
    const removals = active.filter((hostname) => !candidateSet.has(hostname));
    return {
      available: true,
      candidateCount: candidates.length,
      activeCount: active.length,
      pendingAdditionCount: additions.length,
      pendingRemovalCount: removals.length,
      additions: additions.slice(0, 100),
      removals: removals.slice(0, 100),
      truncated: additions.length > 100 || removals.length > 100,
      recoveryId: typeof metadata.recovery_id === "string" ? metadata.recovery_id.slice(0, 64) : null,
    };
  } catch {
    return { available: false, candidateCount: 0, activeCount: 0, pendingAdditionCount: 0,
      pendingRemovalCount: 0, additions: [], removals: [], truncated: false, recoveryId: null };
  }
}

module.exports = { readFailoverInventoryStatus, readHostFile };
