const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  php: {
    memoryLimitMb: 512,
    maxExecutionSeconds: 300,
  },
  opcache: {
    memoryMb: 512,
    internedStringsMb: 64,
    maxFiles: 100000,
    validateTimestamps: true,
    revalidateSeconds: 60,
  },
  fastcgi: {
    keysZoneMb: 128,
    maxSizeGb: 8,
    inactiveMinutes: 60,
    validMinutes: 30,
    readTimeoutSeconds: 300,
    cacheLock: true,
  },
  redis: {
    maxMemoryMb: 1024,
    policy: "allkeys-lru",
  },
  mysql: {
    bufferPoolMb: 2048,
    maxConnections: 150,
    redoLogCapacityMb: 1024,
  },
};

function integer(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    const error = new Error(`${name} must be between ${minimum} and ${maximum}`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validate(payload = {}) {
  const source = {
    php: { ...DEFAULTS.php, ...(payload.php || {}) },
    opcache: { ...DEFAULTS.opcache, ...(payload.opcache || {}) },
    fastcgi: { ...DEFAULTS.fastcgi, ...(payload.fastcgi || {}) },
    redis: { ...DEFAULTS.redis, ...(payload.redis || {}) },
    mysql: { ...DEFAULTS.mysql, ...(payload.mysql || {}) },
  };
  const policy = String(source.redis.policy || "");
  if (!["allkeys-lru", "allkeys-lfu", "volatile-lru", "volatile-lfu", "noeviction"].includes(policy)) {
    const error = new Error("Redis eviction policy is invalid");
    error.statusCode = 400;
    throw error;
  }
  return {
    php: {
      memoryLimitMb: integer(source.php.memoryLimitMb, "PHP memory limit", 128, 2048),
      maxExecutionSeconds: integer(source.php.maxExecutionSeconds, "PHP execution time", 30, 1800),
    },
    opcache: {
      memoryMb: integer(source.opcache.memoryMb, "OPcache memory", 128, 4096),
      internedStringsMb: integer(source.opcache.internedStringsMb, "Interned strings memory", 16, 256),
      maxFiles: integer(source.opcache.maxFiles, "OPcache file limit", 10000, 1000000),
      validateTimestamps: Boolean(source.opcache.validateTimestamps),
      revalidateSeconds: integer(source.opcache.revalidateSeconds, "OPcache revalidation interval", 0, 3600),
    },
    fastcgi: {
      keysZoneMb: integer(source.fastcgi.keysZoneMb, "FastCGI keys zone", 16, 1024),
      maxSizeGb: integer(source.fastcgi.maxSizeGb, "FastCGI cache size", 1, 100),
      inactiveMinutes: integer(source.fastcgi.inactiveMinutes, "FastCGI inactive time", 1, 1440),
      validMinutes: integer(source.fastcgi.validMinutes, "FastCGI validity", 1, 1440),
      readTimeoutSeconds: integer(source.fastcgi.readTimeoutSeconds, "FastCGI read timeout", 30, 1800),
      cacheLock: Boolean(source.fastcgi.cacheLock),
    },
    redis: {
      maxMemoryMb: integer(source.redis.maxMemoryMb, "Redis memory", 128, 8192),
      policy,
    },
    mysql: {
      bufferPoolMb: integer(source.mysql.bufferPoolMb, "MySQL buffer pool", 512, 12288),
      maxConnections: integer(source.mysql.maxConnections, "MySQL connections", 25, 1000),
      redoLogCapacityMb: integer(source.mysql.redoLogCapacityMb, "MySQL redo capacity", 256, 8192),
    },
  };
}

function setIni(content, key, value) {
  const line = `${key} = ${value}`;
  const expression = new RegExp(`^\\s*${key.replaceAll(".", "\\.")}\\s*=.*$`, "m");
  return expression.test(content) ? content.replace(expression, line) : `${content.trimEnd()}\n${line}\n`;
}

function renderPhpIni(content, settings) {
  const values = {
    memory_limit: `${settings.php.memoryLimitMb}M`,
    max_execution_time: settings.php.maxExecutionSeconds,
    "opcache.memory_consumption": settings.opcache.memoryMb,
    "opcache.interned_strings_buffer": settings.opcache.internedStringsMb,
    "opcache.max_accelerated_files": settings.opcache.maxFiles,
    "opcache.validate_timestamps": settings.opcache.validateTimestamps ? 1 : 0,
    "opcache.revalidate_freq": settings.opcache.revalidateSeconds,
    "opcache.jit": 0,
    "opcache.jit_buffer_size": 0,
  };
  return Object.entries(values).reduce((result, [key, value]) => setIni(result, key, value), content);
}

function renderNginx(nginxContent, defaultContent, settings) {
  let nginx = nginxContent
    .replace(/fastcgi_read_timeout\s+\d+s;/, `fastcgi_read_timeout ${settings.fastcgi.readTimeoutSeconds}s;`)
    .replace(/keys_zone=WORDPRESS:\d+m/, `keys_zone=WORDPRESS:${settings.fastcgi.keysZoneMb}m`)
    .replace(/inactive=\d+m/, `inactive=${settings.fastcgi.inactiveMinutes}m`)
    .replace(/max_size=\d+g/, `max_size=${settings.fastcgi.maxSizeGb}g`);
  let server = defaultContent
    .replace(
      /fastcgi_cache_valid 200 301 302 \d+m;/,
      `fastcgi_cache_valid 200 301 302 ${settings.fastcgi.validMinutes}m;`,
    )
    .replace(/^\s*fastcgi_cache_lock(?:_timeout)?\s+.*;\n?/gm, "");
  server = server.replace(
    /(\s*fastcgi_cache_methods GET HEAD;\n)/,
    `$1        fastcgi_cache_lock ${settings.fastcgi.cacheLock ? "on" : "off"};\n        fastcgi_cache_lock_timeout 10s;\n`,
  );
  return { nginx, server };
}

class PerformanceSettings {
  constructor(options) {
    this.path = path.join(options.dataDir, "performance-settings.json");
    this.phpIniPath = options.phpIniPath;
    this.nginxPath = options.nginxPath;
    this.nginxDefaultPath = options.nginxDefaultPath;
  }

  read() {
    if (!fs.existsSync(this.path)) return clone(DEFAULTS);
    try {
      return validate(JSON.parse(fs.readFileSync(this.path, "utf8")));
    } catch {
      return clone(DEFAULTS);
    }
  }

  save(payload) {
    const settings = validate(payload);
    fs.writeFileSync(this.path, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
    return settings;
  }

  snapshot() {
    return {
      settingsExists: fs.existsSync(this.path),
      settingsContent: fs.existsSync(this.path) ? fs.readFileSync(this.path, "utf8") : "",
      phpContent: fs.readFileSync(this.phpIniPath, "utf8"),
      nginxContent: fs.readFileSync(this.nginxPath, "utf8"),
      nginxDefaultContent: fs.readFileSync(this.nginxDefaultPath, "utf8"),
    };
  }

  restore(snapshot) {
    if (snapshot.settingsExists) {
      fs.writeFileSync(this.path, snapshot.settingsContent, { encoding: "utf8", mode: 0o600 });
    } else {
      fs.rmSync(this.path, { force: true });
    }
    fs.writeFileSync(this.phpIniPath, snapshot.phpContent, "utf8");
    fs.writeFileSync(this.nginxPath, snapshot.nginxContent, "utf8");
    fs.writeFileSync(this.nginxDefaultPath, snapshot.nginxDefaultContent, "utf8");
  }

  applyFiles(settings = this.read()) {
    const phpBefore = fs.readFileSync(this.phpIniPath, "utf8");
    const nginxBefore = fs.readFileSync(this.nginxPath, "utf8");
    const defaultBefore = fs.readFileSync(this.nginxDefaultPath, "utf8");
    const rendered = renderNginx(nginxBefore, defaultBefore, settings);
    fs.writeFileSync(this.phpIniPath, renderPhpIni(phpBefore, settings), "utf8");
    fs.writeFileSync(this.nginxPath, rendered.nginx, "utf8");
    fs.writeFileSync(this.nginxDefaultPath, rendered.server, "utf8");
    return { phpBefore, nginxBefore, defaultBefore };
  }
}

module.exports = { DEFAULTS, PerformanceSettings, renderNginx, renderPhpIni, validate };
