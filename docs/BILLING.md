# Billing Inventory Service

`hosting-billing` is an isolated renewal-inventory service. It has its own
administrator login, SQLite database, browser UI, authenticated internal API,
audit history, and restore-tested backups. It does not mount website data,
MySQL, runtime configuration, or the Docker socket.

The service is intentionally unable to suspend or otherwise mutate hosted
sites. It calculates renewal state and can create WooCommerce renewal orders,
but reminders and enforcement remain future work.

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

## WooCommerce Payments

Open **Payments** and configure:

- the HTTPS WooCommerce store URL;
- the public HTTPS URL that routes to `hosting-billing:8787`;
- the ID of one hidden virtual renewal product;
- a least-privilege WooCommerce REST API consumer key and secret;
- a separate webhook secret and payment-link lifetime.

Secrets are AES-256-GCM encrypted and are never returned by the API. Blank
secret fields preserve their existing values. The generated key is stored as
`app-data/billing/woocommerce-settings.key` unless
`BILLING_SETTINGS_KEY` is supplied.

Creating a link first creates one pending WooCommerce order with service ID,
period, resulting paid-through date, and a random nonce in order metadata. The
public link contains only a 256-bit random token; SQLite stores only its SHA-256
hash. Only one unexpired pending link can exist for a service.

Configure a WooCommerce **Order updated** webhook:

```text
Delivery URL: https://billing.example.com/webhooks/woocommerce
Secret: the exact webhook secret saved in Billing
```

The handler accepts signed `order.created` and `order.updated` deliveries.
`processing` or `completed` extends service state only when order ID, amount,
and currency match. Delivery IDs and payment state make callbacks idempotent.
Forged, replayed, mismatched, expired, refunded, cancelled, and failed cases do
not silently extend or shorten service; ambiguous paid/refund cases are marked
for manual review in audit history.

The payment implementation has no nginx, Docker, website, or enforcement
access. Before client use, qualify it with a dedicated test product and test
the store's real checkout, paid webhook, duplicate delivery, refund, and outage
behavior.

## Renewal Reminders

**Reminders** previews services currently in `reminder`, `grace`, or
`suspended` state. **Send due now** creates one durable outbox entry per service,
paid-through date, and state. A successful entry is never sent twice; a failed
entry remains retryable and preserves a bounded error and attempt count.

Daily scheduling is disabled by default. When enabled, it runs once after the
selected local time in the container timezone. The scheduler records its last
local run date so a restart cannot resend the same reminder key.

Billing sends only allowlisted fields to:

```text
http://hosting-ui:8687/internal/v1/billing-reminders
```

The request uses `BILLING_API_TOKEN`. `hosting-ui` validates the service ID,
domain, state, date, day count, and 64-character reminder key, then constructs
the notification text itself. Arbitrary billing-supplied messages are ignored.
The existing notification manager owns Telegram/SMTP credentials, provider
retries, channel state, and a second durable dedupe boundary. If no delivery
channel is enabled, billing records a failed attempt instead of marking the
reminder sent.

## Internal API

`GET /internal/v1/entitlements` requires:

```text
Authorization: Bearer <BILLING_API_TOKEN>
```

The response includes a generation timestamp, current service state, and an
HMAC-SHA256 signature over the unsigned JSON payload. Consumers must verify the
signature and freshness before relying on it. Future enforcement must retain a
last-known-good copy and fail open when state is stale or unavailable.

`hosting-ui` includes that consumer as an observe-only foundation. Under
**Settings > Billing entitlement observer**, an operator can manually refresh
or enable scheduled verification. The observer:

- uses only the internal `BILLING_API_URL` and `BILLING_API_TOKEN`;
- verifies the exact response HMAC with a timing-safe comparison;
- rejects stale, future, malformed, duplicated, or unsupported services;
- atomically retains the last verified snapshot in panel data;
- compares canonical billing domains and aliases with local primary websites;
- reports matches and inventory drift with `Action: None (dry run)`.

The observer has no nginx writer, Docker adapter, or enforcement setting.
Failed, unavailable, or stale responses leave the last-known-good snapshot
untouched and cannot suspend a website.

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
