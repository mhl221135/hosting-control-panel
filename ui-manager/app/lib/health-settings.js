const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  enabled: false,
  intervalMinutes: 5,
  diskWarningPercent: 80,
  diskCriticalPercent: 90,
  certificateWarningDays: 30,
  certificateCriticalDays: 7,
  opcacheWarningPercent: 95,
  requiredContainers: [
    "hosting-ui",
    "hosting-nginx",
    "hosting-php-fpm",
    "hosting-db",
    "hosting-npm",
    "hosting-redis",
  ],
};

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function containerList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/);
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function validate(payload = {}) {
  const settings = {
    enabled: Boolean(payload.enabled),
    intervalMinutes: Number(payload.intervalMinutes ?? DEFAULTS.intervalMinutes),
    diskWarningPercent: Number(payload.diskWarningPercent ?? DEFAULTS.diskWarningPercent),
    diskCriticalPercent: Number(payload.diskCriticalPercent ?? DEFAULTS.diskCriticalPercent),
    certificateWarningDays: Number(payload.certificateWarningDays ?? DEFAULTS.certificateWarningDays),
    certificateCriticalDays: Number(payload.certificateCriticalDays ?? DEFAULTS.certificateCriticalDays),
    opcacheWarningPercent: Number(payload.opcacheWarningPercent ?? DEFAULTS.opcacheWarningPercent),
    requiredContainers: containerList(payload.requiredContainers ?? DEFAULTS.requiredContainers),
  };
  const integer = (name, minimum, maximum) => {
    if (!Number.isInteger(settings[name]) || settings[name] < minimum || settings[name] > maximum) {
      throw validationError(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
  };
  integer("intervalMinutes", 1, 60);
  integer("diskWarningPercent", 50, 98);
  integer("diskCriticalPercent", 51, 99);
  integer("certificateWarningDays", 7, 90);
  integer("certificateCriticalDays", 1, 30);
  integer("opcacheWarningPercent", 50, 99);
  if (settings.diskWarningPercent >= settings.diskCriticalPercent) {
    throw validationError("Disk warning threshold must be lower than the critical threshold");
  }
  if (settings.certificateCriticalDays >= settings.certificateWarningDays) {
    throw validationError("Certificate critical days must be lower than warning days");
  }
  if (!settings.requiredContainers.length || settings.requiredContainers.length > 30) {
    throw validationError("Configure between 1 and 30 required containers");
  }
  if (settings.requiredContainers.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name))) {
    throw validationError("Required container names contain unsupported characters");
  }
  return settings;
}

class HealthSettings {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.path = path.join(dataDir, "health-settings.json");
  }

  read() {
    try {
      return validate({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.path, "utf8")) });
    } catch (error) {
      if (error.statusCode) throw error;
      return { ...DEFAULTS, requiredContainers: [...DEFAULTS.requiredContainers] };
    }
  }

  save(payload) {
    const settings = validate(payload);
    fs.writeFileSync(this.path, JSON.stringify({ ...settings, updatedAt: new Date().toISOString() }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    return settings;
  }
}

module.exports = { DEFAULTS, HealthSettings, validate };
