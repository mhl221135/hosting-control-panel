const fs = require("fs");
const net = require("net");
const path = require("path");

function validateIpv4(value) {
  const ip = String(value || "").trim();
  if (net.isIP(ip) !== 4) {
    const error = new Error(`Invalid IPv4 address: ${ip || "(empty)"}`);
    error.statusCode = 400;
    throw error;
  }
  return ip;
}

class IpAddressStore {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, "cloudflare-ip-addresses.json");
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  save(values) {
    if (!Array.isArray(values)) {
      const error = new Error("IP address list must be an array");
      error.statusCode = 400;
      throw error;
    }
    const addresses = [...new Set(values.map(validateIpv4))];
    if (addresses.length > 50) {
      const error = new Error("Store no more than 50 server IP addresses");
      error.statusCode = 400;
      throw error;
    }
    fs.writeFileSync(this.filePath, JSON.stringify(addresses, null, 2), { encoding: "utf8", mode: 0o600 });
    return addresses;
  }
}

module.exports = { IpAddressStore, validateIpv4 };
