#!/usr/bin/env node

const fs = require("fs");
const http = require("http");

const endpoint = new URL(process.env.HOSTING_AGENT_URL || "http://hosting-agent:8790");
const token = String(process.env.HOSTING_AGENT_TOKEN || "");
const args = process.argv.slice(2);

if (token.length < 32) {
  process.stderr.write("HOSTING_AGENT_TOKEN is not configured\n");
  process.exit(78);
}

function request(pathname, metadata, input) {
  const encoded = Buffer.from(JSON.stringify(metadata)).toString("base64url");
  const req = http.request({
    hostname: endpoint.hostname,
    port: endpoint.port || 80,
    method: "POST",
    path: pathname,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Hosting-Args": encoded,
      "Content-Type": "application/octet-stream",
    },
  }, (res) => {
    if (res.statusCode !== 200) {
      let error = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { error += chunk; });
      res.on("end", () => {
        try {
          error = JSON.parse(error).message || error;
        } catch {}
        process.stderr.write(`${error || `Hosting agent returned HTTP ${res.statusCode}`}\n`);
        process.exit(1);
      });
      return;
    }
    res.pipe(process.stdout, { end: false });
    res.on("end", () => {
      const stderr = Buffer.from(String(res.trailers["x-stderr"] || ""), "base64url").toString();
      if (stderr) process.stderr.write(stderr);
      process.exit(Number(res.trailers["x-exit-code"] || 1));
    });
  });
  req.on("error", (error) => {
    process.stderr.write(`Hosting agent connection failed: ${error.message}\n`);
    process.exit(1);
  });
  input.pipe(req);
}

if (args[0] === "cp") {
  if (args.length !== 3 || args[1].includes(":") || !args[2].includes(":")) {
    process.stderr.write("Only local package copies into the PHP runtime are supported\n");
    process.exit(1);
  }
  const input = fs.createReadStream(args[1]);
  input.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
  request("/v1/copy", { destination: args[2] }, input);
} else {
  request("/v1/exec", args, process.stdin);
}
