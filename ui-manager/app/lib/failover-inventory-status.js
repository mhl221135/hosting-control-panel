const fs = require("fs");
const path = require("path");

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function hostList(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some((hostname) => !HOSTNAME.test(hostname))) return null;
  return [...value];
}

function readFailoverInventoryStatus(dataDir) {
  try {
    const filename = path.join(dataDir, "failover-inventory.json");
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) throw new Error("Unsafe inventory status");
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    const additions = hostList(value.additions);
    const removals = hostList(value.removals);
    if (value.version !== 1 || value.available !== true || !additions || !removals) throw new Error("Unavailable inventory status");
    const counts = [value.candidateCount, value.activeCount, value.pendingAdditionCount, value.pendingRemovalCount];
    if (counts.some((count) => !Number.isInteger(count) || count < 0 || count > 5000)) throw new Error("Invalid inventory counts");
    return {
      available: true,
      candidateCount: value.candidateCount,
      activeCount: value.activeCount,
      pendingAdditionCount: value.pendingAdditionCount,
      pendingRemovalCount: value.pendingRemovalCount,
      additions,
      removals,
      truncated: value.truncated === true,
      recoveryId: typeof value.recoveryId === "string" ? value.recoveryId.slice(0, 64) : null,
    };
  } catch {
    return { available: false, candidateCount: 0, activeCount: 0, pendingAdditionCount: 0,
      pendingRemovalCount: 0, additions: [], removals: [], truncated: false, recoveryId: null };
  }
}

module.exports = { readFailoverInventoryStatus };
