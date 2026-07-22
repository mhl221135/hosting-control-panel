# Agent Handoff

This file is the engineering entrypoint for Codex, Claude Code, and other
automated contributors. Read it before changing the stack.

## Mission

Websites V2 is a Docker Compose WordPress hosting control plane for ARM64 and
AMD64 Linux. It manages many WordPress document roots through one internal
nginx, one PHP-FPM container with a pool per site, MySQL, Redis, Nginx Proxy
Manager (NPM), and an authenticated Node.js control panel.

The supported installation root defaults to `/media/ssdmount/websites-v2`:

- `sources`: this Git checkout; replaceable by an upgrade
- `app-data`: persistent service state and active runtime configuration
- `websites`: live website files
- `backups`: panel-managed restore points
- `exports`: portable migration exports
- `imports`: staged migration input

Never confuse versioned templates under `sources/global-configs-new-upd` with
the active copies under `app-data/configs`.

## Read First

1. `README.md`: features, installation, and administrator workflows.
2. `docs/ARCHITECTURE.md`: service boundaries, module ownership, and flows.
3. `docs/CONFIGURATION.md`: environment variables and persistent state.
4. `docs/HIGH_AVAILABILITY.md`: recovery boundaries and failover design.
5. `docs/API.md`: panel HTTP API groups and authentication contract.
6. `docs/OPERATIONS.md`: testing, deployment, rollback, and diagnostics.
7. `STACK_OVERVIEW.md`: short runtime overview.

## Non-Negotiable Safety Rules

- Do not commit `.env`, tokens, passwords, account files, private keys,
  certificates, database dumps, website content, or production data.
- Make source changes in a Git checkout first. Do not hand-edit deployed source
  or generated files inside running containers.
- Treat `app-data`, `websites`, `backups`, `exports`, and `imports` as user data.
  Never delete, reset, overwrite, or migrate them without explicit approval.
- Do not recreate MySQL, NPM, or PHP containers for a panel-only change.
- Do not publish MySQL `3306` or Redis `6379`; they are intentionally internal.
- Do not attach unrelated host services to `hosting-net` just to proxy them.
- Validate nginx and PHP-FPM before reload. Configuration writers must restore
  their previous files when validation or reload fails.
- Website PHP must never receive Docker socket access. Only `hosting-ui` owns
  that control-plane privilege.
- Preserve unrelated working-tree changes. `import-sites.json` is local
  production input and must not be committed.
- Backups, image optimization, website imports, and website deletion share an
  operation lock by design. Do not remove it or introduce parallel disk-heavy
  work without measuring impact.

## Source Of Truth

| Concern | Source of truth |
|---|---|
| Containers, mounts, ports, network | `docker-compose.yml` |
| Initial secrets and root path | `.env` generated from `.env.example` |
| Active host routing | `app-data/configs/nginx/conf.d/sites.map` |
| Active FastCGI state | `app-data/configs/nginx/conf.d/cache.map` |
| Active PHP pools | `app-data/configs/php-fpm/pools.conf` |
| Per-site switches | `app-data/ui-manager/site-state.json` |
| Panel account | `app-data/ui-manager/admin-account.json` |
| Encrypted integrations | `app-data/ui-manager/integration-settings.json` |
| Encryption key | `UI_SETTINGS_KEY` or `integration-settings.key` |
| Backup schedule | `app-data/ui-manager/backup-settings.json` |
| Performance values | `app-data/ui-manager/performance-settings.json` |
| Versioned initial configs | `global-configs-new-upd/` |

The panel edits active configuration. Upgrades copy versioned templates only
when the corresponding active configuration does not exist.

## Change Map

- Panel routes and orchestration: `ui-manager/app/server.js`
- Authentication/session behavior: `ui-manager/app/lib/auth.js`
- NPM and Cloudflare APIs: `ui-manager/app/lib/integrations.js`
- Encrypted integration settings: `ui-manager/app/lib/integration-settings.js`
- Runtime map/pool parsing and rendering: `ui-manager/app/lib/runtime-config.js`
- WordPress/database provisioning: `ui-manager/app/lib/provisioner.js`
- Provision import staging: `ui-manager/app/lib/provision-import-store.js`
- Cache/backup switches: `ui-manager/app/lib/site-state.js`
- Backup and restore: `ui-manager/app/lib/backup-manager.js`
- Removal ownership rules: `ui-manager/app/lib/site-removal-plan.js`
- Export/import: `ui-manager/app/lib/migration-manager.js` and
  `ui-manager/app/cli/sites-transfer.js`
- Performance config rendering: `ui-manager/app/lib/performance-settings.js`
- Statistics: `ui-manager/app/lib/stats-collector.js`
- WebP jobs: `ui-manager/app/lib/image-optimization-manager.js`
- Browser UI: `ui-manager/app/public/{index.html,app.js,styles.css}`
- Fresh setup: `bootstrap.sh`, `scripts/configure.sh`, `scripts/install.sh`
- Non-destructive upgrade: `scripts/upgrade.sh`

## Required Verification

For panel changes, run from the repository root:

```bash
node --check ui-manager/app/server.js
node --check ui-manager/app/public/app.js
node --test ui-manager/app/test/*.test.js
docker compose config --quiet
git diff --check
```

Also run targeted syntax checks for every changed JavaScript file. For shell
changes use `sh -n script.sh`. For nginx/PHP configuration changes, validate in
containers or equivalent images before deployment.

Frontend changes require checking the actual panel at desktop and mobile widths.
Do not assume successful JavaScript parsing proves the interface is usable.

## Deployment Discipline

1. Test locally.
2. Commit intentionally; never include local import manifests or secrets.
3. Push the authoritative repository.
4. Fast-forward the deployment checkout.
5. Build and recreate only affected services when practical.
6. Check `docker compose ps`, the panel/website HTTP response, and changed
   service logs.
7. Confirm the deployed Git commit.

The full supported update path is `sudo ./scripts/upgrade.sh`. A narrow panel
deployment may rebuild and recreate only `hosting-ui`. See
`docs/OPERATIONS.md` for commands and rollback rules.

## Design Constraints

- Prefer Node.js built-ins; the panel deliberately has no package-manager
  dependency tree.
- Keep API responses JSON and errors shaped as `{ ok: false, message, details }`.
- All non-auth API routes require a valid session. All mutating requests also
  require `X-CSRF-Token`.
- Validate domains, paths, identifiers, and numeric limits at the boundary.
- Use `execFile` with argument arrays for variable command input. Do not insert
  user-controlled values into shell strings.
- Keep aliases grouped with their primary site in the UI. Shared document root
  and pool ownership is the grouping contract.
- Cloudflare Security manages only rules whose `ref` starts with
  `hosting-control-`; never mutate arbitrary customer rules.
- Cloudflare Free rate limiting supports only a 10-second counting period and
  10-second mitigation. The login preset is path-based and zone-wide.
- NPM is pinned to the tested release in Compose. Upgrade it deliberately and
  test API compatibility before changing the pin.

## Completion Standard

A change is complete only when source, tests, documentation, both repository
copies when applicable, and the requested deployment agree. Report tests that
could not run and any production action that was intentionally skipped.

# AWS Guidance

- Prefer the AWS MCP Server for AWS interactions — it provides sandboxed
  execution, observability, and audit logging. If unavailable, use the
  AWS CLI directly.
- Before starting a task, check whether a relevant AWS skill is available.
  Load the skill with `retrieve_skill` and prefer its guidance over
  general knowledge.
- When uncertain about specific AWS details (API parameters, permissions,
  limits, error codes), verify against documentation rather than guessing.
  State uncertainty explicitly if you cannot confirm.
- When creating infrastructure, prefer infrastructure-as-code (AWS CDK or
  CloudFormation) over direct CLI commands.
- When working with infrastructure, follow AWS Well-Architected Framework
  principles.
- Do not use em dashes in AWS resource names or descriptions. Use
  hyphens instead.

## Secret Safety

- MUST load the `aws-secrets-manager` skill first for any secret,
  credential, API key, token, or password task. MUST NOT call
  `secretsmanager get-secret-value` or `batch-get-secret-value`, and MUST
  NOT hit the Secrets Manager Agent daemon directly. MUST use
  `{{resolve:secretsmanager:secret-id:SecretString:json-key}}` with
  `asm-exec` so the secret resolves at runtime without entering context.
