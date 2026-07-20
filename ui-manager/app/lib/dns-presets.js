const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SUPPORTED_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "CAA"];

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

class DnsPresetStore {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, "dns-presets.json");
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.map((preset) => {
        if (Array.isArray(preset.records)) return preset;
        return {
          id: preset.id || crypto.randomUUID(),
          label: preset.label || "Imported preset",
          records: [{
            id: crypto.randomUUID(),
            type: preset.type,
            nameTemplate: preset.nameTemplate,
            contentTemplate: preset.contentTemplate,
            ttl: preset.ttl,
            priority: preset.priority,
            proxied: preset.proxied,
          }],
          updatedAt: preset.updatedAt || new Date().toISOString(),
        };
      });
    } catch {
      return [];
    }
  }

  validateRecord(payload, existingId = "") {
    const type = String(payload.type || "A").trim().toUpperCase();
    const nameTemplate = String(payload.nameTemplate || payload.name_template || "@").trim().toLowerCase();
    const contentTemplate = String(payload.contentTemplate || payload.content_template || "").trim();
    const ttl = Number(payload.ttl || 1);
    const priority = Number(payload.priority || 10);
    if (!SUPPORTED_TYPES.includes(type)) throw validationError(`Supported DNS types are ${SUPPORTED_TYPES.join(", ")}`);
    if (!nameTemplate || nameTemplate.length > 253) throw validationError("DNS name template is required");
    if (!contentTemplate || contentTemplate.length > 2048) throw validationError("DNS content template is required");
    if (ttl !== 1 && (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400)) {
      throw validationError("TTL must be automatic (1) or between 60 and 86400 seconds");
    }
    if (type === "MX" && (!Number.isInteger(priority) || priority < 0 || priority > 65535)) {
      throw validationError("MX priority must be between 0 and 65535");
    }
    return {
      id: existingId || crypto.randomUUID(),
      type,
      nameTemplate,
      contentTemplate,
      ttl,
      priority: type === "MX" ? priority : 0,
      proxied: ["A", "AAAA", "CNAME"].includes(type) && Boolean(payload.proxied),
    };
  }

  validate(payload, existingId = "") {
    const label = String(payload.label || "").trim();
    if (!label || label.length > 80) throw validationError("Preset name is required and must be under 80 characters");
    const incomingRecords = Array.isArray(payload.records) ? payload.records : [payload];
    if (!incomingRecords.length || incomingRecords.length > 50) {
      throw validationError("A DNS preset must contain between 1 and 50 records");
    }
    return {
      id: existingId || crypto.randomUUID(),
      label,
      records: incomingRecords.map((record) => this.validateRecord(record, String(record.id || ""))),
      updatedAt: new Date().toISOString(),
    };
  }

  save(payload) {
    const presets = this.read();
    const id = String(payload.id || "");
    const existingIndex = id ? presets.findIndex((preset) => preset.id === id) : -1;
    if (id && existingIndex < 0) {
      const error = new Error("DNS preset not found");
      error.statusCode = 404;
      throw error;
    }
    const preset = this.validate(payload, id);
    if (existingIndex >= 0) presets[existingIndex] = preset;
    else presets.push(preset);
    fs.writeFileSync(this.filePath, JSON.stringify(presets, null, 2), { encoding: "utf8", mode: 0o600 });
    return preset;
  }

  delete(id) {
    const presets = this.read();
    const next = presets.filter((preset) => preset.id !== id);
    if (next.length === presets.length) {
      const error = new Error("DNS preset not found");
      error.statusCode = 404;
      throw error;
    }
    fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  resolveAll(id, domain) {
    const preset = this.read().find((item) => item.id === id);
    if (!preset) {
      const error = new Error("DNS preset not found");
      error.statusCode = 404;
      throw error;
    }
    return preset.records.map((record) => {
      const replaceDomain = (value) => String(value).replaceAll("{domain}", domain);
      const template = replaceDomain(record.nameTemplate);
      let name;
      if (template === "@") name = domain;
      else if (template.endsWith(`.${domain}`) || template === domain) name = template;
      else name = `${template}.${domain}`;
      return {
        ...record,
        name,
        content: replaceDomain(record.contentTemplate),
      };
    });
  }

  resolve(id, domain) {
    return this.resolveAll(id, domain)[0];
  }
}

module.exports = { DnsPresetStore, SUPPORTED_TYPES };
