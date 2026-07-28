# Billing Inventory Service

`hosting-billing` is an isolated renewal-inventory service. It has its own
administrator login, SQLite database, browser UI, authenticated internal API,
audit history, and restore-tested backups. It does not mount website data,
MySQL, runtime configuration, or the Docker socket.

Phase 1 is intentionally read-only with respect to hosting. It calculates and
publishes renewal state, but it cannot suspend a site, create a WooCommerce
order, or send reminders.

## Storage And Network

| Item | Location |
|---|---|
| Database and administrator hash | `app-data/billing` |
| Verified database snapshots | `${BACKUPS_DIR}/billing` |
| Browser/API port | `8787` |
| Internal endpoint | `http://hosting-billing:8787/internal/v1/entitlements` |

The container runs as UID/GID `33:33`, drops all capabilities, uses a read-only
root filesystem, and receives only its two writable mounts. Port `8787` is
published for initial administration. Publish it through NPM only after adding
the intended hostname and access policy.

## Authentication

The billing administrator is independent from the hosting-panel account.
`BILLING_ADMIN_EMAIL` and `BILLING_ADMIN_PASSWORD` initialize the account only
when no billing account file exists. Later environment changes do not overwrite
the stored account; use **Account** in the billing UI.

Browser sessions use an HTTP-only cookie, expiry, login throttling, and CSRF
tokens. The internal API uses the separate `BILLING_API_TOKEN`. Treat that token
as a service credential and rotate both consumers together.

## Inventory Import

Open **Import**, select a CSV, review its fingerprint and sample, type `IMPORT`,
and apply it. The service accepts its canonical export format and maps the
legacy hosting sheet headers, including `Order #`, `Client Type`, `Website`, and
`Hosting`. Import is transactional. A malformed row rejects the entire file,
and the exact same CSV fingerprint cannot be replayed.

Stable service IDs are the record identity. A domain can change without
creating a second service. Missing paid-through dates fail open as `exempt`.
Calculated states are:

- `active`: paid beyond the reminder window;
- `reminder`: expiry is inside the configured reminder window;
- `grace`: paid-through has passed but configured grace remains;
- `suspended`: grace has elapsed;
- `exempt`: missing dates or an explicit exemption.

Phase 1 does not enforce the calculated state.

## Internal API

`GET /internal/v1/entitlements` requires:

```text
Authorization: Bearer <BILLING_API_TOKEN>
```

The response includes a generation timestamp, current service state, and an
HMAC-SHA256 signature over the unsigned JSON payload. Consumers must verify the
signature and freshness before relying on it. Future enforcement must retain a
last-known-good copy and fail open when state is stale or unavailable.

## Backups And Restore

**Create backup** uses SQLite's online backup API, checks database integrity,
writes a SHA-256 manifest, atomically promotes the completed directory, and
applies `BILLING_BACKUP_RETENTION`.

**Test** copies a selected snapshot to a temporary database and verifies
integrity and schema without changing live data. **Restore** requires the exact
backup ID, creates a verified pre-restore safety snapshot, and rolls back to
that snapshot if the selected restore fails.

Billing backups are independent of website backups. They should also be covered
by the existing encrypted off-site backup of `BACKUPS_DIR`.

## Verification

Run the full suite in the pinned runtime:

```bash
docker build -t hosting-billing:test billing-service
docker run --rm hosting-billing:test npm test
```

The suite covers password/session behavior, bearer authentication, CSV mapping
and replay protection, renewal states, migrations, transactions, audit, backup,
restore, and the live HTTP contract.
