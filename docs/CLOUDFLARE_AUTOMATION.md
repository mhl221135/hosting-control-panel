# Cloudflare Automation

The authenticated **Security** workspace provides opt-in bulk hardening,
provisioning defaults, temporary incident actions, and rollback for state owned
by Hosting Control. It uses the separate Cloudflare Security token; DNS record
management continues to use the DNS token.

## Bulk Workflow

1. Select one or more primary websites and presets.
2. Run **Preview changes**. The panel reads current provider state and shows
   create, update, unchanged, compatibility, permission, and plan results.
3. Review warnings and confirm **Apply reviewed changes**.
4. Follow the durable background job in **Jobs**.
5. Use **Rollback** on its completed batch to reverse only changes recorded by
   that batch.

Available presets cover the WordPress login rate limit, XML-RPC blocking,
sensitive-file probes, conservative zone security settings, conservative cache
settings, and optional Always Online. WordPress-only presets are rejected for
static sites. Zone settings are deduplicated when selected sites share a zone.
Always Online is never enabled by default and cannot preserve dynamic behavior
such as carts, logins, comments, or form submissions.

The apply job recalculates the preview immediately before changing anything.
If provider state changed, or the preview contains compatibility, permission,
or plan errors, the job stops. Rules use stable `hosting-control-*` references.
Existing unrelated rules and DNS records are not rewritten. Rollback restores
the exact previous panel rule or zone setting recorded during apply; partial
rollback remains visible for operator recovery.

## Provisioning Defaults

**Security > Provisioning defaults** controls the global preset selection.
Defaults are disabled on a fresh installation. When globally enabled, the
provision form exposes **Apply configured Cloudflare security defaults** as a
per-site opt-in/opt-out. Cloudflare failures are warning steps and do not remove
an otherwise usable new website.

## Traffic Actions

The selected-site traffic view offers:

- an on-demand IPinfo lookup for context;
- a temporary managed challenge;
- a temporary block;
- a full zone cache purge.

Challenges and blocks accept one exact public IPv4 or IPv6 address selected
from the current bounded traffic sample. They are scoped to the selected
hostname and its `www` alias, expire after 10 minutes, 1 hour, 24 hours, or 7
days, and can be removed immediately from **Security**. The scheduler queues
durable removal jobs for expired rules.

Every action requires a fresh server-generated preview and confirmation. The
panel rechecks that the address remains in the same traffic sample before it
queues a mutation. It rejects private, reserved, multicast, documentation,
configured server, operator-protected, and published Cloudflare proxy
addresses. IPinfo metadata is never used to decide or automatically apply an
action.

Mitigations are idempotent for a website/address pair and store the operator,
source statistics time, exact scope, expiry, and provider rule IDs in
`cloudflare-incidents.json`. The file contains operational production data and
must not be committed.

## Runtime Files

All files are under `app-data/ui-manager`:

| File | Purpose |
|---|---|
| `cloudflare-automation-settings.json` | global defaults and protected addresses |
| `cloudflare-automation-history.json` | bounded bulk results and rollback state |
| `cloudflare-incidents.json` | bounded temporary mitigation audit and expiry state |

The files are written atomically with mode `0600`, included in normal app-data
backups, and excluded from Git.
