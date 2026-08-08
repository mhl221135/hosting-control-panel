# Remote WordPress Plugin

`wordpress-plugin/hostpilot-remote` is the fail-open remote billing consumer.
It enrolls one WordPress installation, stores its credential encrypted, polls
the billing service every 15 minutes, verifies contract-version-1 Ed25519
signatures, and exposes safe status in **Tools > Site Health** and
**Settings > HostPilot Billing**.

This phase does not suspend, redirect, or modify the public website. A missing,
expired, malformed, unreachable, mismatched, or invalidly signed entitlement
leaves the website available and records only a bounded error category.

## Build And Install

```bash
./scripts/build-remote-wordpress-plugin.sh
```

The ignored `wordpress-plugin/dist` directory receives a normal plugin ZIP, a
separate MU-loader ZIP, and `SHA256SUMS`. Install and activate the normal ZIP.
The optional loader file belongs directly in `wp-content/mu-plugins`; it loads
the normal plugin code but cannot prevent a hosting administrator from removing
both packages.

In Billing, open **Remote WP**, initialize the signing key if none exists,
select an eligible `shared` service, and create a one-time code. In WordPress,
open **Settings > HostPilot Billing**, enter the HTTPS billing origin, exact
canonical domain, and code. The code and returned credential are never shown
again by the plugin.

## Stored State

- `hostpilot_remote_config`: billing origin, approved domain, installation ID,
  and the credential encrypted with libsodium secretbox using a key derived
  from WordPress `AUTH_KEY` and `SECURE_AUTH_KEY`; non-autoloaded.
- `hostpilot_remote_entitlement`: last verified allowlisted payload;
  non-autoloaded.
- `hostpilot_remote_status`: last attempt, last success, and a bounded safe
  category; non-autoloaded.

Changing WordPress salts makes the credential undecryptable and safely requires
re-enrollment. WordPress multisite is currently unsupported and fails open.

## Operations

Use **Check billing now** after enrollment or payment. WP-Cron is a convenience,
so low-traffic sites may need an external request scheduler. Disconnect removes
the local credential; revoke the installation separately in Billing. Ordinary
deactivation preserves enrollment. Explicit WordPress uninstall removes the
plugin-owned options and scheduled event.

The HTTP client requires HTTPS, uses WordPress safe remote requests, rejects
redirects and unsafe URLs, limits responses to 64 KiB, and uses a 10-second
timeout. The renewal URL is validated but never fetched while polling.
