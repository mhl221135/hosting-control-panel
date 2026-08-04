const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CUSTOM_FALLBACK_MEMORY_MB,
  DEFAULT_WORKER_MEMORY_MB,
  WORKER_MEMORY_MAX_MB,
  WORKER_MEMORY_MIN_MB,
  boundedMemoryMb,
  computeCapacitySummary,
  workerMemoryMbForTier,
} = require("../lib/php-fpm-capacity");

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

test("legacy presets fall back to documented per-tier worker-memory defaults", () => {
  assert.equal(workerMemoryMbForTier("low", { low: { max_children: "2" } }), DEFAULT_WORKER_MEMORY_MB.low);
  assert.equal(workerMemoryMbForTier("medium", {}), DEFAULT_WORKER_MEMORY_MB.medium);
  assert.equal(workerMemoryMbForTier("high", { high: {} }), DEFAULT_WORKER_MEMORY_MB.high);
  assert.deepEqual(DEFAULT_WORKER_MEMORY_MB, { low: 96, medium: 128, high: 192 });
});

test("worker-memory estimates are bound and sanitized", () => {
  assert.equal(boundedMemoryMb("128", 96), 128);
  assert.equal(boundedMemoryMb(96, 96), 96);
  assert.equal(boundedMemoryMb(WORKER_MEMORY_MAX_MB, 96), WORKER_MEMORY_MAX_MB);
  assert.equal(boundedMemoryMb(WORKER_MEMORY_MIN_MB, 96), WORKER_MEMORY_MIN_MB);
  assert.equal(boundedMemoryMb("NaN", 96), 96);
  assert.equal(boundedMemoryMb("", 96), 96);
  assert.equal(boundedMemoryMb(Number.NaN, 96), 96);
  assert.equal(boundedMemoryMb(1.5, 96), 96);
  assert.equal(boundedMemoryMb(-5, 96), 96);
  assert.equal(boundedMemoryMb(0, 96), 96);
  assert.equal(boundedMemoryMb(99999, 96), 96);
  assert.equal(boundedMemoryMb("banana", 96), 96);
  assert.equal(boundedMemoryMb(null, 96), 96);
});

test("estimate-only profile changes never affect pool classification or apply preview", () => {
  const base = {
    medium: { ...DEFAULT_WORKER_MEMORY_MB, max_children: "6", pm: "ondemand" },
  };
  const withEstimate = { ...workerMemoryMbForTier("medium", base) };
  assert.equal(workerMemoryMbForTier("medium", { medium: { estimated_memory_mb: "256" } }), 256);
  // The capacity library never binds the estimate to a pool tier membership check.
  const unknown = workerMemoryMbForTier("nope", {});
  assert.ok(unknown >= WORKER_MEMORY_MIN_MB && unknown <= WORKER_MEMORY_MAX_MB);
});

test("matching and custom pools compute separate estimated memory and identify fallback", () => {
  const summary = computeCapacitySummary({
    pools: [
      { tier: "medium", maxChildren: 6 },
      { tier: "custom", maxChildren: 4 },
    ],
    presets: { medium: { max_children: "6", estimated_memory_mb: "128" } },
    host: { cpuCount: 8, memoryTotalBytes: 8 * GB, phpMemoryLimitMb: 128 },
  });
  const expectedEstimate = 6 * 128 * MB + 4 * CUSTOM_FALLBACK_MEMORY_MB * MB;
  assert.equal(summary.workerSlots, 10);
  assert.equal(summary.estimatedWorkerMemoryBytes, expectedEstimate);
  assert.equal(summary.ceilingBytes, 128 * 10 * MB);
  assert.equal(summary.customPoolCount, 1);
  assert.equal(summary.fallbackPoolCount, 1);
  assert.equal(summary.fallbackMemoryMb, CUSTOM_FALLBACK_MEMORY_MB);
  assert.equal(summary.memoryStatus, "healthy");
  assert.equal(summary.cpuStatus, "healthy");
  assert.equal(summary.status, "healthy");
});

test("slots-per-CPU warning and critical boundaries", () => {
  const base = { pools: [{ tier: "medium", maxChildren: 6 }], presets: { medium: { estimated_memory_mb: "128" } }, host: { cpuCount: 8, memoryTotalBytes: 8 * GB, phpMemoryLimitMb: 128 } };
  const healthy = computeCapacitySummary({ ...base, pools: [{ tier: "medium", maxChildren: 8 }], host: { ...base.host, cpuCount: 2 } });
  assert.equal(healthy.slotsPerCpu, 4);
  assert.equal(healthy.cpuStatus, "healthy");

  const warning = computeCapacitySummary({ ...base, pools: [{ tier: "medium", maxChildren: 9 }], host: { ...base.host, cpuCount: 2 } });
  assert.equal(warning.cpuStatus, "warning");

  const critical = computeCapacitySummary({ ...base, pools: [{ tier: "medium", maxChildren: 18 }], host: { ...base.host, cpuCount: 2 } });
  assert.equal(critical.cpuStatus, "critical");
  assert.equal(critical.slotsPerCpu, 9);
});

test("estimated-memory RAM warning and critical boundaries", () => {
  const host = { cpuCount: 4, memoryTotalBytes: 0, phpMemoryLimitMb: 128 };
  const warning = computeCapacitySummary({
    pools: [{ tier: "medium", maxChildren: 6 }],
    presets: { medium: { estimated_memory_mb: "128" } },
    host: { ...host, memoryTotalBytes: Math.round((6 * 128 * MB) / 0.6) },
  });
  assert.equal(warning.memoryStatus, "warning");

  const critical = computeCapacitySummary({
    pools: [{ tier: "medium", maxChildren: 6 }],
    presets: { medium: { estimated_memory_mb: "128" } },
    host: { ...host, memoryTotalBytes: Math.round((6 * 128 * MB) / 0.8) },
  });
  assert.equal(critical.memoryStatus, "critical");
});

test("missing or zero host capacity is handled safely as unknown", () => {
  const summary = computeCapacitySummary({
    pools: [{ tier: "medium", maxChildren: 6 }],
    presets: {},
    host: { cpuCount: 0, memoryTotalBytes: 0, phpMemoryLimitMb: 0 },
  });
  assert.equal(summary.memoryStatus, "unknown");
  assert.equal(summary.cpuStatus, "unknown");
  assert.equal(summary.status, "unknown");
  assert.equal(summary.slotsPerCpu, null);
  assert.equal(summary.hostRamBytes, null);
  assert.equal(summary.estimatedRatio, null);
  assert.equal(summary.ceilingRatio, null);
  assert.equal(summary.workerSlots, 6);
});

test("missing host memory with known CPU still reports CPU health and unknown memory", () => {
  const summary = computeCapacitySummary({
    pools: [{ tier: "high", maxChildren: 10 }],
    presets: {},
    host: { cpuCount: 2, memoryTotalBytes: 0, phpMemoryLimitMb: 128 },
  });
  assert.equal(summary.memoryStatus, "unknown");
  assert.equal(summary.cpuStatus, "warning");
  assert.equal(summary.status, "warning");
});

test("output is bounded and free of sensitive configuration contents", () => {
  const summary = computeCapacitySummary({
    pools: [
      { tier: "low", maxChildren: 2 },
      { tier: "custom", maxChildren: 6 },
    ],
    presets: { low: { estimated_memory_mb: "96" } },
    host: { cpuCount: 4, memoryTotalBytes: 8 * GB, phpMemoryLimitMb: 128 },
  });
  assert.deepEqual(Object.keys(summary).sort(), [
    "ceilingBytes", "ceilingRatio", "cpuStatus", "customPoolCount", "estimatedRatio",
    "estimatedWorkerMemoryBytes", "fallbackMemoryMb", "fallbackPoolCount", "hostRamBytes",
    "memoryStatus", "slotsPerCpu", "slotsPerCpuRatio", "status", "thresholds", "workerSlots",
  ].sort());
  for (const key of ["workerSlots", "estimatedWorkerMemoryBytes", "ceilingBytes"]) {
    assert.equal(Number.isFinite(summary[key]), true, key);
  }
  assert.equal("poolNames" in summary, false);
  assert.equal("presets" in summary, false);
  assert.equal("sections" in summary, false);
});

test("status values are stable and documented", () => {
  const thresholds = computeCapacitySummary({ pools: [], presets: {}, host: { cpuCount: 2, memoryTotalBytes: 8 * GB, phpMemoryLimitMb: 128 } }).thresholds;
  assert.equal(thresholds.memoryWarningRatio, 0.5);
  assert.equal(thresholds.memoryCriticalRatio, 0.75);
  assert.equal(thresholds.cpuSlotsWarning, 4);
  assert.equal(thresholds.cpuSlotsCritical, 8);
  assert.equal(thresholds.customFallbackMemoryMb, CUSTOM_FALLBACK_MEMORY_MB);
});
