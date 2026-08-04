const { parsePools, renderPools } = require("./runtime-config");

const PRESET_FIELDS = {
  pm: "pm",
  max_children: "pm.max_children",
  start_servers: "pm.start_servers",
  min_spare_servers: "pm.min_spare_servers",
  max_spare_servers: "pm.max_spare_servers",
  process_idle_timeout: "pm.process_idle_timeout",
  request_terminate_timeout: "request_terminate_timeout",
  max_requests: "pm.max_requests",
};

function normalizeTier(tier, presets) {
  const key = String(tier || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(presets || {}, key) ? key : "";
}

function detectTier(pool, presets) {
  if (!pool) return "custom";
  const keys = [
    "pm",
    "pm.max_children",
    "pm.start_servers",
    "pm.min_spare_servers",
    "pm.max_spare_servers",
    "pm.process_idle_timeout",
    "request_terminate_timeout",
    "pm.max_requests",
  ];
  for (const [tierName, tier] of Object.entries(presets || {})) {
    const isMatch = keys.every((k) => {
      const poolValue = String(pool[k] || "").trim();
      const tierKey = k === "pm" ? "pm" : k.replace("pm.", "");
      const tierValue = String(tier[tierKey] || "").trim();
      return poolValue === tierValue;
    });
    if (isMatch) return tierName;
  }
  return "custom";
}

function previewApply(payload, poolsContent, currentPresets) {
  const pools = parsePools(poolsContent);
  const affected = [];
  const customPools = [];
  for (const name of pools.sectionOrder) {
    const settings = pools.sections[name] || {};
    const tier = detectTier(settings, currentPresets);
    if (tier === "custom" || !payload[tier]) {
      customPools.push({ name, tier: "custom" });
      continue;
    }
    const changes = Object.entries(PRESET_FIELDS).flatMap(([presetKey, poolKey]) => {
      const from = String(settings[poolKey] || "");
      const to = String(payload[tier][presetKey] || "");
      return from === to ? [] : [{ field: poolKey, from, to }];
    });
    if (changes.length) affected.push({ name, tier, changes });
  }
  return { affected, customPools };
}

function buildApplyPlan(payload, poolsContent, currentPresets, selectedPools) {
  const { affected, customPools } = previewApply(payload, poolsContent, currentPresets);
  const affectedNames = new Set(affected.map((p) => p.name));
  const selection = Array.isArray(selectedPools) ? selectedPools : [];
  const invalid = selection.filter((name) => !affectedNames.has(name));
  if (invalid.length) {
    const error = new Error(`Selected pools are not affected by the proposed presets: ${invalid.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  const selected = affected.filter((p) => selection.includes(p.name));
  return { selected, customPools, affected };
}

async function applyPlan(plan, deps) {
  const {
    poolsPath,
    presetsPath,
    sitesMapPath,
    readFile,
    writeFile,
    renameFile,
    backupFile,
    validateConfig,
    reloadPhp,
    verifyPorts,
  } = deps;

  if (!plan || !Array.isArray(plan.selected) || plan.selected.length === 0) {
    const error = new Error("No pools selected to apply");
    error.statusCode = 400;
    throw error;
  }

  const poolsBefore = readFile(poolsPath);
  const presetsBefore = readFile(presetsPath);
  const sitesMapBefore = readFile(sitesMapPath);

  const pools = parsePools(poolsBefore);
  const storedPresets = JSON.parse(presetsBefore);
  const newPresets = { ...storedPresets, ...plan.payload };

  for (const pool of plan.selected) {
    const settings = pools.sections[pool.name];
    if (!settings) {
      const error = new Error(`Pool '${pool.name}' no longer exists`);
      error.statusCode = 409;
      throw error;
    }
    for (const change of pool.changes) {
      if (String(settings[change.field] || "") !== String(change.from || "")) {
        const error = new Error(`Pool '${pool.name}' changed after preview; preview again before applying`);
        error.statusCode = 409;
        throw error;
      }
      settings[change.field] = change.to;
    }
  }

  const poolsAfter = renderPools(pools);

  backupFile(presetsPath, presetsBefore);
  backupFile(poolsPath, poolsBefore);
  backupFile(sitesMapPath, sitesMapBefore);

  const restore = async () => {
    const restoreFile = (filePath, content) => {
      const temporary = `${filePath}.${process.pid}.rollback.tmp`;
      writeFile(temporary, content);
      renameFile(temporary, filePath);
    };
    restoreFile(poolsPath, poolsBefore);
    restoreFile(presetsPath, presetsBefore);
  };

  try {
    const presetsTmp = `${presetsPath}.${process.pid}.tmp`;
    writeFile(presetsTmp, JSON.stringify(newPresets, null, 2));
    renameFile(presetsTmp, presetsPath);
    const poolsTmp = `${poolsPath}.${process.pid}.tmp`;
    writeFile(poolsTmp, poolsAfter);
    renameFile(poolsTmp, poolsPath);
    await validateConfig();
  } catch (error) {
    try {
      await restore();
    } catch (rollbackError) {
      error.rollbackError = rollbackError.message;
    }
    error.message = `Configuration write or validation failed; changes were rolled back. ${error.message}`;
    throw error;
  }

  try {
    await reloadPhp();
    await verifyPorts();
  } catch (error) {
    await restore();
    try {
      await validateConfig();
      await reloadPhp();
    } catch (rollbackError) {
      error.rollbackError = rollbackError.message;
    }
    error.message = `PHP-FPM reload or port verification failed; changes were rolled back. ${error.message}`;
    throw error;
  }

  return { applied: plan.selected.map((p) => p.name) };
}

module.exports = {
  PRESET_FIELDS,
  applyPlan,
  buildApplyPlan,
  detectTier,
  normalizeTier,
  previewApply,
};
