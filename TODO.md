# Project TODO

This file lists only work that is not implemented. Completed features belong in
the README and detailed documentation instead of this list.

## Operator Experience

- Add one shared background-jobs view for backups, imports/exports, image work,
  and maintenance, with durable history, cancellation where safe, and clear
  conflict/queue state.
- Add notification delivery for failed jobs, expiring certificates, low disk,
  and unhealthy services. Support Telegram and SMTP/email first; keep Telegram
  command execution as a later, separately permissioned feature.
- Expose the existing website import/export workflows in the authenticated UI
  with progress and manifest download/upload controls.

## WordPress Lifecycle

- Add controlled WordPress core, plugin, and theme updates using a mandatory
  pre-update backup, health check, and automatic rollback on failure.
- Add an adapter interface for database-backed non-WordPress applications,
  starting with an optional generic PHP/MySQL site and an OpenCart adapter.

## Cloudflare

- Add bulk application of selected security/DNS presets across chosen zones and
  optional automatic security presets during provisioning.
- Add conservative Cloudflare incident actions from traffic diagnostics, with
  explicit confirmation, expiry, allowlists, and an audit log.

## Commercial Hosting

- Build a separate billing/entitlement service for renewals and expiry state,
  with CSV import/export and WooCommerce payment-link integration. Enforcement
  must work at the edge so it also covers HTML/PHP and externally hosted sites.

## Resilience

- Add encrypted off-site backup replication to S3-compatible storage with
  retention verification and restore testing. Telegram must not be used as
  primary backup storage.
