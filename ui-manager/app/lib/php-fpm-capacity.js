const MB_BYTES = 1024 * 1024;

const WORKER_MEMORY_MB_KEY = "estimated_memory_mb";
const DEFAULT_WORKER_MEMORY_MB = { low: 96, medium: 128, high: 192 };
const WORKER_MEMORY_MIN_MB = 32;
const WORKER_MEMORY_MAX_MB = 4096;
const CUSTOM_FALLBACK_MEMORY_MB = 256;

const MEMORY_WARNING_RATIO = 0.5;
const MEMORY_CRITICAL_RATIO = 0.75;
const CEILING_WARNING_RATIO = 0.75;
const CEILING_CRITICAL_RATIO = 0.9;
const CPU_SLOTS_WARNING = 4;
const CPU_SLOTS_CRITICAL = 8;

function boundedMemoryMb(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < WORKER_MEMORY_MIN_MB || parsed > WORKER_MEMORY_MAX_MB) {
    return Number(fallback);
  }
  return parsed;
}

function workerMemoryMbForTier(tier, presets) {
  const tierName = String(tier || "").toLowerCase();
  const preset = presets && typeof presets === "object" ? presets[tierName] : null;
  const stored = preset && typeof preset === "object" ? preset[WORKER_MEMORY_MB_KEY] : undefined;
  const fallback = DEFAULT_WORKER_MEMORY_MB[tierName] !== undefined
    ? DEFAULT_WORKER_MEMORY_MB[tierName]
    : CUSTOM_FALLBACK_MEMORY_MB;
  return boundedMemoryMb(stored, fallback);
}

function poolEstimateMb(pool, presets, fallbackMemoryMb = CUSTOM_FALLBACK_MEMORY_MB) {
  const tier = String(pool?.tier || "").toLowerCase();
  if (tier === "custom") return { mb: fallbackMemoryMb, fallback: true };
  return { mb: workerMemoryMbForTier(tier, presets), fallback: false };
}

function statusForRatio(warningRatio, criticalRatio, ratio) {
  if (ratio > criticalRatio) return "critical";
  if (ratio > warningRatio) return "warning";
  return "healthy";
}

function summarizeStatus(memoryStatus, cpuStatus) {
  if (memoryStatus === "critical" || cpuStatus === "critical") return "critical";
  if (memoryStatus === "warning" || cpuStatus === "warning") return "warning";
  if (memoryStatus === "unknown" || cpuStatus === "unknown") return "unknown";
  return "healthy";
}

function computeCapacitySummary({ pools = [], presets = {}, host = {} } = {}) {
  const cpuCount = Number(host.cpuCount);
  const memoryTotalBytes = Number(host.memoryTotalBytes);
  const phpMemoryLimitMb = Number(host.phpMemoryLimitMb);
  const knownCpu = Number.isFinite(cpuCount) && cpuCount > 0;
  const knownRam = Number.isFinite(memoryTotalBytes) && memoryTotalBytes > 0;
  const knownLimit = Number.isFinite(phpMemoryLimitMb) && phpMemoryLimitMb > 0;

  let workerSlots = 0;
  let estimatedMemoryBytes = 0;
  let ceilingBytes = 0;
  let customPools = 0;
  let fallbackPools = 0;

  for (const pool of pools) {
    const maxChildren = Number(pool?.maxChildren);
    if (!Number.isInteger(maxChildren) || maxChildren < 0) continue;
    const { mb, fallback } = poolEstimateMb(pool, presets);
    const children = Math.max(0, maxChildren);
    workerSlots += children;
    estimatedMemoryBytes += mb * children * MB_BYTES;
    if (knownLimit) ceilingBytes += phpMemoryLimitMb * children * MB_BYTES;
    if (fallback) fallbackPools += 1;
    if (String(pool?.tier || "").toLowerCase() === "custom") customPools += 1;
  }

  const slotsPerCpu = knownCpu ? workerSlots / cpuCount : null;
  const estimatedRatio = knownRam ? estimatedMemoryBytes / memoryTotalBytes : null;
  const ceilingRatio = knownRam && ceilingBytes > 0 ? ceilingBytes / memoryTotalBytes : null;

  const memoryStatus = (() => {
    if (!knownRam || !knownLimit) return "unknown";
    const estimated = estimatedRatio !== null ? statusForRatio(MEMORY_WARNING_RATIO, MEMORY_CRITICAL_RATIO, estimatedRatio) : "healthy";
    const ceiling = ceilingRatio !== null ? statusForRatio(CEILING_WARNING_RATIO, CEILING_CRITICAL_RATIO, ceilingRatio) : "healthy";
    if (estimated === "critical" || ceiling === "critical") return "critical";
    if (estimated === "warning" || ceiling === "warning") return "warning";
    return "healthy";
  })();

  const cpuStatus = (() => {
    if (!knownCpu) return "unknown";
    const ratio = workerSlots / cpuCount;
    if (ratio > CPU_SLOTS_CRITICAL) return "critical";
    if (ratio > CPU_SLOTS_WARNING) return "warning";
    return "healthy";
  })();

  return {
    workerSlots,
    slotsPerCpu: slotsPerCpu === null ? null : Math.round(slotsPerCpu * 10) / 10,
    estimatedWorkerMemoryBytes: estimatedMemoryBytes,
    ceilingBytes,
    hostRamBytes: knownRam ? memoryTotalBytes : null,
    estimatedRatio: estimatedRatio === null ? null : Math.round(estimatedRatio * 1000) / 1000,
    ceilingRatio: ceilingRatio === null ? null : Math.round(ceilingRatio * 1000) / 1000,
    slotsPerCpuRatio: slotsPerCpu === null ? null : Math.round(slotsPerCpu * 10) / 10,
    memoryStatus,
    cpuStatus,
    status: summarizeStatus(memoryStatus, cpuStatus),
    customPoolCount: customPools,
    fallbackPoolCount: fallbackPools,
    fallbackMemoryMb: CUSTOM_FALLBACK_MEMORY_MB,
    thresholds: {
      memoryWarningRatio: MEMORY_WARNING_RATIO,
      memoryCriticalRatio: MEMORY_CRITICAL_RATIO,
      ceilingWarningRatio: CEILING_WARNING_RATIO,
      ceilingCriticalRatio: CEILING_CRITICAL_RATIO,
      cpuSlotsWarning: CPU_SLOTS_WARNING,
      cpuSlotsCritical: CPU_SLOTS_CRITICAL,
      workerMemoryMinMb: WORKER_MEMORY_MIN_MB,
      workerMemoryMaxMb: WORKER_MEMORY_MAX_MB,
      customFallbackMemoryMb: CUSTOM_FALLBACK_MEMORY_MB,
    },
  };
}

module.exports = {
  CEILING_CRITICAL_RATIO,
  CEILING_WARNING_RATIO,
  CPU_SLOTS_CRITICAL,
  CPU_SLOTS_WARNING,
  CUSTOM_FALLBACK_MEMORY_MB,
  DEFAULT_WORKER_MEMORY_MB,
  MEMORY_CRITICAL_RATIO,
  MEMORY_WARNING_RATIO,
  WORKER_MEMORY_MB_KEY,
  WORKER_MEMORY_MAX_MB,
  WORKER_MEMORY_MIN_MB,
  boundedMemoryMb,
  computeCapacitySummary,
  poolEstimateMb,
  workerMemoryMbForTier,
};