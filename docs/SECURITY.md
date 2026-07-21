# Security

This stack is an administrative control plane for multiple WordPress sites. A
panel or Docker-socket compromise can become a full-host compromise, so it must
be treated as privileged infrastructure rather than as another website.

## Repository policy

Never commit:

- `.env` or credential exports;
- Cloudflare, NPM, database, panel, or File Browser secrets;
- NPM data, Let's Encrypt state, certificates, or private keys;
- application databases, SQL dumps, WordPress backups, or `wp-config.php`;
- access/error logs or screenshots from a live installation;
- production domains, service routes, account identifiers, public IP
  inventories, certificate names, or customer website lists.

Run this before every push:

```sh
./scripts/security-audit.sh
```

For deployment-specific domain and service-name checks, create an untracked
`.security-deny-patterns` file with one extended regular expression per line.
The audit fails if any tracked text matches. This keeps the production inventory
out of the repository while still enforcing it on the deployment workstation.

The script rejects common runtime artifacts and live screenshots, detects
Cloudflare token/private-key patterns, and scans Git history with Gitleaks.
Removing a leaked file in a later commit does not remove it from history. Public
history containing sensitive binary or text blobs must be rewritten, all open
pull-request refs checked, and exposed credentials rotated.

## Credential storage

| Credential | Persistent authority | Dependent configuration |
| --- | --- | --- |
| Panel login | `app-data/ui-manager/admin-account.json` scrypt hash | `.env` first-install fallback |
| NPM administrator | NPM database password auth record | `.env`, encrypted panel integration settings |
| File Browser administrator | File Browser database hash | `.env` first-install fallback |
| MySQL root | MySQL grant tables | `.env`, database and phpMyAdmin container environments |
| NPM database user | MySQL grant tables | `.env`, NPM and database container environments |
| WordPress database users | MySQL grant tables | each site's `wp-config.php` |
| Cloudflare tokens | Cloudflare account plus encrypted panel settings | optional `.env` fallback |
| Panel integration encryption key | `UI_SETTINGS_KEY` or generated key file | decrypts saved integration secrets |

Do not casually rotate `UI_SETTINGS_KEY`. Replacing it without re-encrypting the
stored integration settings makes the saved NPM and Cloudflare secrets
unreadable. Cloudflare tokens must be revoked and regenerated at Cloudflare;
then update them in **Settings** and clear obsolete `.env` fallbacks.

## Credential rotation

Run from the installed source directory during a maintenance window:

```sh
sudo ./scripts/rotate-credentials.sh --apply
```

The script:

1. verifies the current panel, NPM, MySQL, and File Browser state;
2. asks for replacement panel, NPM, File Browser, MySQL root, and NPM database
   passwords without echoing them;
3. optionally rotates every WordPress database user and updates the matching
   `wp-config.php`;
4. updates NPM through its authenticated API and the panel account through its
   scrypt account store;
5. updates encrypted panel NPM credentials and `.env` atomically;
6. recreates only containers whose environment changed and validates logins and
   WordPress database connectivity.

The command intentionally does not rotate Cloudflare tokens, ACME account keys,
TLS private keys, WordPress administrator passwords, or `UI_SETTINGS_KEY`.
Those have separate ownership and revocation procedures.

## Network exposure

Only public website ports 80 and 443 should be reachable from the Internet.
The default Compose file currently publishes panel `8687`, NPM administration
`81`, and phpMyAdmin `8484` on all host interfaces for compatibility with the
existing deployment. On a directly connected WAN host, restrict these ports
with a host/provider firewall or change the mappings to loopback-only bindings.
NPM can still proxy to `hosting-ui`, `hosting-files`, and
`hosting-phpmyadmin` over `hosting-net` without public raw admin ports.

MySQL and Redis have no host port mappings and are reachable only on
`hosting-net`. Redis is intentionally passwordless on that isolated network.

## Trust boundaries

- `hosting-ui` runs as root and mounts `/var/run/docker.sock`. Panel compromise
  is equivalent to root access on the Docker host. Keep the panel behind strong
  authentication and an identity-aware access layer; do not expose port 8687.
- NPM terminates public traffic and owns TLS private keys. Protect its data and
  administration endpoint separately from WordPress.
- Website PHP shares one container but uses per-site pools and `open_basedir`.
  This reduces accidental cross-site access but is not equivalent to a separate
  container or VM per untrusted customer.
- Backups contain databases and often `wp-config.php` credentials. Apply strict
  filesystem permissions and encrypt off-host copies.
- Uploaded plugin/theme ZIPs execute third-party PHP during provisioning. Only
  use licensed, trusted packages and scan them independently; ZIP validity and
  a WordPress header are not malware verification.

## Existing controls

- Panel passwords use scrypt with per-account salt.
- Sessions are HTTP-only, SameSite Strict, expire after eight hours, and use
  CSRF tokens for state-changing API requests.
- Login attempts are throttled, though the in-memory limiter resets when the
  panel restarts and must not be the only Internet-facing control.
- NPM and Cloudflare integration secrets use AES-256-GCM at rest.
- MySQL and Redis are not published on host ports.
- Cloudflare DNS and security tokens are separated so permissions can be scoped
  independently.
- Destructive site removal performs ownership checks and typed confirmation.
