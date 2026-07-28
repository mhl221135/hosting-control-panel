const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { validatePackageNames } = require("./wordpress-maintenance");

function boundedText(value, maximum = 500) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum);
}

function packageIds(values) {
  const ids = [...new Set((Array.isArray(values) ? values : []).map(String))];
  if (ids.length > 100 || ids.some((id) => !/^[a-f0-9-]{20,50}$/i.test(id))) {
    throw Object.assign(new Error("Uploaded package selection is invalid"), { statusCode: 400 });
  }
  return ids;
}

function emptyPins() {
  return {
    site: false,
    core: false,
    plugins: [],
    themes: [],
    pluginPackageIds: [],
    themePackageIds: [],
    note: "",
    updatedAt: "",
    updatedBy: "",
  };
}

function normalizePins(input = {}) {
  return {
    site: input.site === true,
    core: input.core === true,
    plugins: validatePackageNames(input.plugins),
    themes: validatePackageNames(input.themes),
    pluginPackageIds: packageIds(input.pluginPackageIds),
    themePackageIds: packageIds(input.themePackageIds),
    note: boundedText(input.note, 300),
    updatedAt: boundedText(input.updatedAt, 40),
    updatedBy: boundedText(input.updatedBy, 160),
  };
}

function requestSelection(input = {}) {
  const selection = {
    core: input.core === true,
    plugins: validatePackageNames(input.plugins),
    themes: validatePackageNames(input.themes),
    pluginPackageIds: packageIds(input.pluginPackageIds),
    themePackageIds: packageIds(input.themePackageIds),
  };
  if (!selection.core && !selection.plugins.length && !selection.themes.length
      && !selection.pluginPackageIds.length && !selection.themePackageIds.length) {
    throw Object.assign(new Error("Select at least one WordPress update"), { statusCode: 400 });
  }
  return selection;
}

function selectedSnapshot(inventory, selection) {
  const plugins = new Set(selection.plugins);
  const themes = new Set(selection.themes);
  return {
    core: inventory.core,
    coreUpdate: inventory.coreUpdate,
    plugins: inventory.plugins
      .filter((item) => plugins.has(item.name))
      .map((item) => ({
        name: item.name,
        status: item.status,
        version: item.version,
        update: item.update,
        updateVersion: item.updateVersion,
      })),
    themes: inventory.themes
      .filter((item) => themes.has(item.name))
      .map((item) => ({
        name: item.name,
        status: item.status,
        version: item.version,
        update: item.update,
        updateVersion: item.updateVersion,
      })),
  };
}

function originRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: "GET",
      headers: options.headers || {},
      timeout: 20_000,
    }, (response) => {
      response.resume();
      response.on("end", () => resolve({
        status: Number(response.statusCode || 0),
        url,
      }));
    });
    request.on("timeout", () => request.destroy(new Error("Origin health check timed out")));
    request.on("error", reject);
    request.end();
  });
}

class WordPressUpdateManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.jobManager = options.jobManager;
    this.backupManager = options.backupManager;
    this.runner = options.runner;
    this.packageStore = options.packageStore;
    this.siteProvider = options.siteProvider;
    this.afterSuccess = options.afterSuccess || (async () => {});
    this.request = options.request || originRequest;
    this.historyPath = path.join(this.dataDir, "wordpress-update-history.json");
    this.pinsPath = path.join(this.dataDir, "wordpress-update-pins.json");
    this.jobManager.register("wordpress.update", (context, payload) => this.apply(payload, context));
  }

  readPins() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.pinsPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new Error("WordPress update pins are unreadable; updates are blocked until the file is repaired");
    }
    if (!parsed || parsed.version !== 1 || !parsed.pins || typeof parsed.pins !== "object") {
      throw new Error("WordPress update pins are invalid; updates are blocked until the file is repaired");
    }
    const pins = {};
    for (const [domain, value] of Object.entries(parsed.pins).slice(0, 1000)) {
      if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain)) {
        throw new Error("WordPress update pins contain an invalid domain");
      }
      pins[domain.toLowerCase()] = normalizePins(value);
    }
    return pins;
  }

  savePins(pins) {
    const temporary = `${this.pinsPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, pins }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, this.pinsPath);
  }

  pinsFor(domain) {
    return this.readPins()[String(domain || "").toLowerCase()] || emptyPins();
  }

  pinsView() {
    return this.readPins();
  }

  async updatePins(domain, input, operator) {
    const site = await this.site(domain);
    const activeUpdate = this.jobManager.list({ type: "wordpress.update", limit: 250 })
      .find((job) => ["queued", "running", "cancelling"].includes(job.status)
        && job.targets.includes(site.host));
    if (activeUpdate) {
      throw Object.assign(new Error("Update exclusions cannot change while this website has an active update job"), {
        statusCode: 409,
      });
    }
    const next = normalizePins({
      ...input,
      updatedAt: new Date().toISOString(),
      updatedBy: operator,
    });
    this.packageStore.resolve("plugins", next.pluginPackageIds);
    this.packageStore.resolve("themes", next.themePackageIds);
    const pins = this.readPins();
    const active = next.site || next.core || next.plugins.length || next.themes.length
      || next.pluginPackageIds.length || next.themePackageIds.length;
    if (active) pins[site.host] = next;
    else delete pins[site.host];
    this.savePins(pins);
    return pins[site.host] || emptyPins();
  }

  assertAllowed(domain, selection) {
    const pins = this.pinsFor(domain);
    const blocked = [];
    if (pins.site) blocked.push("all updates for this website");
    if (selection.core && pins.core) blocked.push("WordPress core");
    for (const name of selection.plugins.filter((item) => pins.plugins.includes(item))) {
      blocked.push(`plugin ${name}`);
    }
    for (const name of selection.themes.filter((item) => pins.themes.includes(item))) {
      blocked.push(`theme ${name}`);
    }
    for (const id of selection.pluginPackageIds.filter((item) => pins.pluginPackageIds.includes(item))) {
      blocked.push(`uploaded plugin package ${id}`);
    }
    for (const id of selection.themePackageIds.filter((item) => pins.themePackageIds.includes(item))) {
      blocked.push(`uploaded theme package ${id}`);
    }
    if (blocked.length) {
      const note = pins.note ? ` Reason: ${pins.note}` : "";
      throw Object.assign(new Error(`Update selection is pinned: ${blocked.join(", ")}.${note}`), {
        statusCode: 409,
      });
    }
    return pins;
  }

  history() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.historyPath, "utf8"));
      return Array.isArray(parsed.history) ? parsed.history : [];
    } catch {
      return [];
    }
  }

  saveHistory(history) {
    const temporary = `${this.historyPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, history: history.slice(0, 100) }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, this.historyPath);
  }

  publicView() {
    return this.history().slice(0, 30).map((entry) => ({
      id: entry.id,
      domain: entry.domain,
      createdAt: entry.createdAt,
      finishedAt: entry.finishedAt || "",
      operator: entry.operator,
      status: entry.status,
      backupId: entry.backupId || "",
      rollback: entry.rollback || "",
      backupSeconds: Number(entry.backupSeconds || 0),
      updateSeconds: Number(entry.updateSeconds || 0),
      rollbackSeconds: Number(entry.rollbackSeconds || 0),
      beforeCore: entry.before?.core || "",
      afterCore: entry.after?.core || "",
      message: entry.message || "",
    }));
  }

  async site(domain) {
    const sites = await this.siteProvider();
    const site = sites.find((item) =>
      item.host === String(domain) && !item.isAlias && !item.isWwwAlias
      && item.state?.siteType === "wordpress");
    if (!site) throw Object.assign(new Error("Configured WordPress website was not found"), { statusCode: 404 });
    return site;
  }

  resolveUploaded(selection) {
    return {
      plugins: this.packageStore.resolve("plugins", selection.pluginPackageIds),
      themes: this.packageStore.resolve("themes", selection.themePackageIds),
    };
  }

  previewHash(preview) {
    const stable = {
      domain: preview.domain,
      selection: preview.selection,
      before: preview.before,
      operations: preview.operations,
    };
    return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
  }

  async preview(input) {
    const site = await this.site(input.domain);
    const selection = requestSelection(input);
    this.assertAllowed(site.host, selection);
    const before = await this.runner.inventory(site);
    const plugins = new Map(before.plugins.map((item) => [item.name, item]));
    const themes = new Map(before.themes.map((item) => [item.name, item]));
    const operations = [];

    if (selection.core) {
      if (!before.coreUpdate?.available || !before.coreUpdate.version) {
        throw Object.assign(new Error("WordPress core does not report an available update"), { statusCode: 409 });
      }
      operations.push({
        kind: "core",
        name: "wordpress",
        from: before.core,
        to: before.coreUpdate.version,
        source: "wordpress.org",
      });
    }
    for (const name of selection.plugins) {
      const item = plugins.get(name);
      if (!item || item.update !== "available" || !item.updateVersion) {
        throw Object.assign(new Error(`Plugin update is no longer available: ${name}`), { statusCode: 409 });
      }
      operations.push({ kind: "plugin", name, from: item.version, to: item.updateVersion, source: "wordpress.org" });
    }
    for (const name of selection.themes) {
      const item = themes.get(name);
      if (!item || item.update !== "available" || !item.updateVersion) {
        throw Object.assign(new Error(`Theme update is no longer available: ${name}`), { statusCode: 409 });
      }
      operations.push({ kind: "theme", name, from: item.version, to: item.updateVersion, source: "wordpress.org" });
    }
    const uploaded = this.resolveUploaded(selection);
    for (const item of [...uploaded.plugins, ...uploaded.themes]) {
      operations.push({
        kind: item.kind === "plugins" ? "plugin" : "theme",
        name: item.name,
        from: "installed version",
        to: "uploaded package",
        source: "package library",
        packageId: item.id,
        uploadedAt: item.uploadedAt,
      });
    }
    const preview = {
      domain: site.host,
      selection,
      before: selectedSnapshot(before, selection),
      operations,
      safeguards: [
        "Create and verify a complete files/database backup",
        "Enable maintenance mode only for this website",
        "Validate WordPress, database, front page, and admin route",
        "Automatically restore the backup after any failure",
      ],
    };
    preview.id = this.previewHash(preview);
    return preview;
  }

  enqueue(preview, operator) {
    if (!preview || !/^[a-f0-9]{64}$/.test(String(preview.id || ""))) {
      throw Object.assign(new Error("A fresh WordPress update preview is required"), { statusCode: 400 });
    }
    return this.jobManager.create({
      type: "wordpress.update",
      label: `Controlled WordPress update for ${preview.domain}`,
      operator,
      trigger: "manual",
      targets: [preview.domain],
      conflicts: ["server-heavy", `site:${preview.domain}`],
      idempotencyKey: `wordpress.update:${preview.domain}`,
      payload: {
        domain: preview.domain,
        selection: preview.selection,
        previewId: preview.id,
        operator,
      },
      total: 8,
      cancellable: false,
      retryable: false,
    });
  }

  async checkHttp(domain) {
    const checks = [];
    for (const [name, url, options] of [
      ["front-page", "http://hosting-nginx/", {
        redirect: "manual",
        headers: { host: domain },
      }],
      ["admin-route", "http://hosting-nginx/wp-admin/", {
        redirect: "manual",
        headers: { host: domain },
      }],
    ]) {
      const response = await this.request(url, {
        ...options,
        signal: AbortSignal.timeout(20_000),
        headers: {
          "user-agent": "Hosting-Control-Update-Health/1.0",
          ...(options.headers || {}),
        },
      });
      if (response.status < 200 || response.status >= 400) {
        throw new Error(`${name} health check returned HTTP ${response.status}`);
      }
      checks.push({ name, status: response.status, finalUrl: boundedText(response.url, 300) });
    }
    return checks;
  }

  async applyOperations(site, selection) {
    const results = [];
    if (selection.core) {
      results.push({ kind: "core", name: "wordpress", message: await this.runner.updateCore(site) });
    }
    for (const result of await this.runner.updatePackages(site, "plugin", selection.plugins)) {
      results.push({ kind: "plugin", ...result });
    }
    for (const result of await this.runner.updatePackages(site, "theme", selection.themes)) {
      results.push({ kind: "theme", ...result });
    }
    const uploaded = this.resolveUploaded(selection);
    for (const item of [...uploaded.plugins, ...uploaded.themes]) {
      results.push({
        kind: item.kind === "plugins" ? "plugin-package" : "theme-package",
        name: item.name,
        message: await this.runner.installUploadedPackage(site, item),
      });
    }
    return results;
  }

  async apply(payload, context) {
    const submitted = {
      domain: payload.domain,
      ...payload.selection,
    };
    const preview = await this.preview(submitted);
    if (preview.id !== payload.previewId) {
      throw Object.assign(new Error("WordPress versions changed after preview; create a new preview"), {
        statusCode: 409,
      });
    }
    const site = await this.site(payload.domain);
    return this.backupManager.withLock({
      type: "wordpress-update",
      domain: site.host,
      label: `Controlled update ${site.host}`,
    }, async () => {
      const record = {
        id: crypto.randomUUID(),
        domain: site.host,
        operator: boundedText(payload.operator, 160),
        createdAt: new Date().toISOString(),
        status: "running",
        before: preview.before,
        operations: preview.operations,
        backupId: "",
        rollback: "",
        backupSeconds: 0,
        updateSeconds: 0,
        rollbackSeconds: 0,
        message: "",
      };
      const history = this.history();
      history.unshift(record);
      this.saveHistory(history);
      let maintenanceActive = false;
      let backup = null;
      let applied = [];
      let updateStartedAt = 0;
      try {
        const backupStartedAt = Date.now();
        context.update({ completed: 0, total: 8, currentStep: "Creating complete pre-update backup" });
        backup = await this.backupManager.createSiteBackup(
          site,
          this.backupManager.readSettings().retention + 1,
        );
        record.backupId = backup.id;
        context.update({ completed: 1, currentStep: "Verifying pre-update backup" });
        record.backupVerification = await this.backupManager.verifySiteBackup(site, backup.id);
        record.backupSeconds = Math.max(1, Math.round((Date.now() - backupStartedAt) / 1000));

        context.update({ completed: 2, currentStep: "Enabling WordPress maintenance mode" });
        await this.runner.setMaintenanceMode(site, true);
        maintenanceActive = true;

        context.update({ completed: 3, currentStep: "Applying selected WordPress updates" });
        updateStartedAt = Date.now();
        applied = await this.applyOperations(site, payload.selection);
        context.update({ completed: 4, results: applied, currentStep: "Validating WordPress and database" });
        await this.runner.validateWordPress(site);

        context.update({ completed: 5, currentStep: "Disabling maintenance mode" });
        await this.runner.setMaintenanceMode(site, false);
        maintenanceActive = false;

        context.update({ completed: 6, currentStep: "Checking public website and admin route" });
        const httpChecks = await this.checkHttp(site.host);
        const after = selectedSnapshot(await this.runner.inventory(site), payload.selection);
        record.updateSeconds = Math.max(1, Math.round((Date.now() - updateStartedAt) / 1000));

        context.update({ completed: 7, currentStep: "Purging website caches" });
        let cacheWarning = "";
        try {
          await this.afterSuccess([site.host]);
        } catch (cacheError) {
          cacheWarning = boundedText(cacheError.stderr || cacheError.message, 500);
        }
        context.update({ completed: 8 });

        Object.assign(record, {
          status: "complete",
          finishedAt: new Date().toISOString(),
          after,
          httpChecks,
          applied,
          cacheWarning,
          message: cacheWarning
            ? `Controlled WordPress update completed; cache purge warning: ${cacheWarning}`
            : "Controlled WordPress update completed",
        });
        this.saveHistory(history);
        return {
          ok: true,
          total: 8,
          completed: 8,
          results: [{
            domain: site.host,
            ok: true,
            backupId: backup.id,
            beforeCore: preview.before.core,
            afterCore: after.core,
            operations: applied.map((item) => ({ kind: item.kind, name: item.name })),
            backupSeconds: record.backupSeconds,
            updateSeconds: record.updateSeconds,
          }],
          message: record.message,
        };
      } catch (error) {
        const original = boundedText(error.stderr || error.message, 700);
        if (updateStartedAt) {
          record.updateSeconds = Math.max(1, Math.round((Date.now() - updateStartedAt) / 1000));
        }
        let rollbackMessage = "not attempted";
        let rollbackCacheWarning = "";
        if (backup?.id) {
          const rollbackStartedAt = Date.now();
          try {
            context.update({ currentStep: "Update failed; restoring verified backup" });
            if (!maintenanceActive) {
              await this.runner.setMaintenanceMode(site, true).catch(() => {});
              maintenanceActive = true;
            }
            await this.backupManager.restoreSiteBackup(site, backup.id);
            await this.runner.validateWordPress(site);
            await this.runner.setMaintenanceMode(site, false).catch(() => {});
            maintenanceActive = false;
            await this.checkHttp(site.host);
            try {
              await this.afterSuccess([site.host]);
            } catch (cacheError) {
              rollbackCacheWarning = boundedText(cacheError.stderr || cacheError.message, 500);
            }
            rollbackMessage = "complete";
          } catch (rollbackError) {
            rollbackMessage = `failed: ${boundedText(rollbackError.stderr || rollbackError.message, 500)}`;
          } finally {
            record.rollbackSeconds = Math.max(1, Math.round((Date.now() - rollbackStartedAt) / 1000));
          }
        }
        record.status = "failed";
        record.finishedAt = new Date().toISOString();
        record.rollback = rollbackMessage;
        record.rollbackCacheWarning = rollbackCacheWarning;
        record.message = `Update failed: ${original}; rollback ${rollbackMessage}`
          + (rollbackCacheWarning ? `; cache purge warning: ${rollbackCacheWarning}` : "");
        record.applied = applied;
        this.saveHistory(history);
        throw new Error(record.message);
      } finally {
        if (maintenanceActive) await this.runner.setMaintenanceMode(site, false).catch(() => {});
      }
    });
  }
}

module.exports = {
  WordPressUpdateManager,
  emptyPins,
  normalizePins,
  originRequest,
  packageIds,
  requestSelection,
  selectedSnapshot,
};
