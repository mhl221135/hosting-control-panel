#!/usr/bin/env node

const { execFile } = require("child_process");
const { promisify } = require("util");
const { migrateCommerceCache } = require("../lib/commerce-cache-migration");

const execFileAsync = promisify(execFile);
const configPath = process.env.NGINX_CONFIG_PATH || "/srv/configs/nginx/nginx.conf";

async function reload() {
  await execFileAsync("docker", ["exec", "hosting-nginx", "nginx", "-t"], { timeout: 30_000 });
  await execFileAsync("docker", ["exec", "hosting-nginx", "nginx", "-s", "reload"], { timeout: 30_000 });
}

migrateCommerceCache(configPath, reload)
  .then((result) => {
    process.stdout.write(result.changed
      ? "Commerce FastCGI exclusions installed.\n"
      : "Commerce FastCGI exclusions are already current.\n");
  })
  .catch((error) => {
    process.stderr.write(`Commerce cache migration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
