const crypto = require("crypto");
const { normalizeService, validationError } = require("./validation");

const CANONICAL_HEADERS = [
  "service_id", "primary_domain", "aliases", "customer_name", "contact_email",
  "contact_phone", "location", "provider", "hosting_paid_through",
  "domain_paid_through", "renewal_months", "hosting_price_minor",
  "domain_price_minor", "currency", "grace_days", "enforcement_mode",
  "manual_state", "timezone", "notes", "source_ref",
];

const HEADER_MAP = {
  "order #": "source_ref",
  "client type": "client_type",
  website: "primary_domain",
  hosting: "provider",
  "hosting status": "hosting_status",
  "domain status": "domain_status",
  "hosting paid": "hosting_paid",
  "hosting months": "renewal_months",
  "hosting next payment": "hosting_paid_through",
  "domain paid": "domain_paid",
  "domain months": "domain_months",
  "domain next payment": "domain_paid_through",
  "price domain": "domain_price",
  "price hosting": "hosting_price",
  email: "contact_email",
  phone: "contact_phone",
  fb: "facebook",
  ig: "instagram",
};

function parseCsv(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 5 * 1024 * 1024) {
    throw validationError("CSV input must be text no larger than 5 MB");
  }
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/, ""));
      if (row.some((item) => item.trim())) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw validationError("CSV contains an unterminated quoted field");
  row.push(value.replace(/\r$/, ""));
  if (row.some((item) => item.trim())) rows.push(row);
  if (rows.length < 2) throw validationError("CSV must contain a header and at least one service");
  if (rows.length > 10_001) throw validationError("CSV may contain at most 10,000 services");
  return rows;
}

function normalizedHeader(value) {
  const lower = String(value || "").trim().toLowerCase();
  return HEADER_MAP[lower] || lower.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function importCsv(text) {
  const rows = parseCsv(text);
  const headers = rows.shift().map(normalizedHeader);
  if (!headers.includes("primary_domain")) throw validationError("CSV requires Website or primary_domain");
  const services = [];
  const errors = [];
  const ids = new Set();
  const domains = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const input = Object.fromEntries(headers.map((header, column) => [header, rows[index][column] || ""]));
    try {
      const service = normalizeService(input);
      if (ids.has(service.service_id)) throw validationError(`Duplicate service ID: ${service.service_id}`);
      if (domains.has(service.primary_domain)) throw validationError(`Duplicate primary domain: ${service.primary_domain}`);
      ids.add(service.service_id);
      domains.add(service.primary_domain);
      services.push(service);
    } catch (error) {
      errors.push({ row: index + 2, message: String(error.message).slice(0, 300) });
      if (errors.length >= 100) break;
    }
  }
  if (errors.length) {
    const error = validationError(
      `CSV validation failed for ${errors.length} row(s): row ${errors[0].row} ${errors[0].message}`,
    );
    error.details = errors;
    throw error;
  }
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(services)).digest("hex");
  return { services, fingerprint };
}

function escapeCsv(value) {
  const text = Array.isArray(value) ? value.join(";") : String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv(services) {
  const lines = [CANONICAL_HEADERS.join(",")];
  for (const service of services) {
    lines.push(CANONICAL_HEADERS.map((header) => escapeCsv(service[header])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

module.exports = { CANONICAL_HEADERS, exportCsv, importCsv, parseCsv };
