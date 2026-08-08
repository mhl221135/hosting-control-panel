# Billing Inventory Service

`hosting-billing` is an isolated renewal-inventory service. It has its own
administrator login, SQLite database, browser UI, authenticated internal API,
audit history, and restore-tested backups. It does not mount website data,
MySQL, runtime configuration, or the Docker socket.

The service is intentionally unable to suspend or otherwise mutate hosted
sites. It calculates renewal state and can create WooCommerce renewal orders,
queues reminders through a narrow panel adapter, and publishes signed
entitlements. Optional local enforcement is owned by the hosting panel and
internal nginx; billing itself has no access to either.

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

Calculated state alone does not enforce anything. Local suspension additionally
requires a fresh signed snapshot, scheduled observation, `payment_page` policy,
the hosting panel's global switch, and an exact pilot allowlist entry.

## Service Management

Open **Services** to create, search, view, and edit the billing inventory. Each
record keeps a stable service ID while its primary domain and aliases remain
editable. Hosting and domain paid-through dates, renewal periods, and prices
are independent. The editor previews both calculated states before saving.

Edits require the record's current `updated_at` value. A stale browser session
receives `409 Conflict` instead of silently overwriting a newer change.
Archiving preserves events, payments, and audit history, removes the record
from active summaries and entitlement output, and can be reversed from the
archived-record filter. There is no hard-delete browser action.

Existing active records expose explicit **Exempt**, **Resume calculated
state**, and **Suspend state** actions. Each requires a reason and the current
`updated_at` value, writes an immutable event, and records the before/after
override in the audit log. The generic editor cannot bypass the reason
requirement. Resume clears the override rather than forcing `active`.
Suspension here is billing state only. It blocks a local website only when
every independent hosting-side enforcement gate is enabled and reconciled.

Schema migration v4 copies each existing `renewal_months` value to the new
domain-renewal period without changing dates or prices. Canonical CSV exports
include both periods and the archived state; legacy `Domain Months` is mapped
to the domain period.

## Remote WordPress Enrollment (Backend)

Phase A1 adds the secure enrollment backend for remotely hosted WordPress
services. Phase A2 adds signatures and backend heartbeat storage. The WordPress
plugin, billing UI heartbeat workflow, frontend suspension, and package
distribution remain future work.

An authenticated billing administrator creates a short-lived, one-time
enrollment code for an eligible service (a non-archived record whose
`location` is `shared`, i.e. remote/shared hosting). The enrollment target must
be the service's canonical primary domain; aliases are not automatically
treated as a new canonical identity. Only one usable pending code and one active
installation may exist per service/domain.

- `enrollment_codes` stores the code as a SHA-256 hash only (`code_hash`). The
  plaintext code is revealed to the administrator exactly once at creation and
  never persisted, logged, or audited.
- `wp_installations` stores the per-installation credential as a SHA-256 hash
  only (`credential_hash`). The plaintext credential is revealed exactly once
  during the public exchange and never persisted, logged, or audited.
- The public `POST /api/enrollment/exchange` consumes the code and creates the
  installation inside a single `BEGIN IMMEDIATE` transaction. Concurrent or
  replayed exchanges are rejected (`409`/`410`) and never create two
  installations; the same generated IDs are used in storage, the response,
  foreign keys, and audit entries.
- Rejected exchanges due to invalid, used, revoked, expired, archived,
  ineligible, or domain-mismatched codes are recorded as bounded
  `enrollment.exchange_rejected` audit entries containing no secrets.
- Enrollment codes and installation credentials can be revoked idempotently.
  Revoked or used codes are never accepted again.
- Exchange/install tables are excluded from portable CSV exports, which carry
  only service inventory.

## Remote Entitlement Signing (Backend)

Phase A2 adds authenticated, asymmetrically signed entitlement delivery for
enrolled installations and signing-key lifecycle management.

An enrolled remote WordPress installation authenticates with its installation
ID and one-time credential via `POST /remote/v1/entitlement`. The installation
is selected by ID and the submitted credential hash is compared in constant
time; authentication errors never reveal which identifier or credential
failed. On success, a deterministic, allowlisted entitlement
payload (contract version, installation ID, canonical domain, entitlement
state, freshness timestamps, renewal URL, display-safe price/currency/period,
enforcement-enabled flag, and key ID) is signed with the active Ed25519
signing key and returned with its signature. The payload contains the key ID.
A future plugin verifies the signature using the public key served by
`GET /remote/v1/keys`, which
returns only the active and still-overlapping previous public keys.

Missing, mismatched, or ambiguous billing data produces a signed fail-open
active entitlement. A valid suspended billing state remains visible in the
payload, but `enforcement_enabled` stays false until the plugin phase is
qualified. Entitlements are short-lived (5-minute TTL). Successful retrievals
write throttled heartbeat fields (`last_seen_at`, `last_success_at`, contract
version, and safe status); failed polls do not update those fields. Renewal
URLs carry an opaque public reference and never expose the internal service ID.

Signing keys are managed by authenticated billing administrators through
`POST /api/enrollment/signing/initialize` (explicit confirmation, requires
`BILLING_SETTINGS_KEY`), `rotate` (requires the caller's last observed active
key ID, replaces it atomically, and retains only its public key for a bounded
overlap), and `retire` (removes a previous key
after its overlap expires; emergency retirement before expiry requires
separate confirmation). Private keys are stored only as AES-256-GCM encrypted
blobs; plaintext private keys are never returned, logged, audited, exported, or
backed up. The encrypted active-key blob is present in verified SQLite backups,
so disaster recovery also requires the independently stored
`BILLING_SETTINGS_KEY`. Exactly one active signing key is maintained; rotation
creates a new one and immediately erases the old encrypted private key. Key
operations are atomic and audited
with only key IDs, safe timestamps, and non-secret metadata.

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

Creating a link requires an explicit **hosting**, **domain**, or **both**
selection. Each selected line carries its own period, amount, and resulting
paid-through date in WooCommerce metadata. Combined payments update both dates
atomically; a domain-only payment cannot change hosting and a hosting-only
payment cannot change the domain. One unexpired pending link is allowed per
service and selection.

Pending rows provide **Cancel** and **Replace** actions. Both require an audit
reason. Cancellation first asks WooCommerce to mark the order `cancelled`; the
local checkout token is invalidated only after WooCommerce confirms the state.
Replacement validates the new line items, cancels that exact active order, and
then creates one fresh order. If new-order creation fails after cancellation,
the cancelled order remains visible and no duplicate active link exists.

The direct payment link contains a 256-bit random token; SQLite stores only its
SHA-256 hash. The operator also receives a stable public renewal URL. Its
`r1_...` reference is an HMAC-derived opaque value created with
`app-data/billing/public-reference.key`, which is included in app-data backups.
It exposes no service ID, domain, contact data, order key, or administrator
credential.

`GET /renew/:reference` is read-only. It displays only the primary domain,
hosting state/date, available pending selections, periods, totals, and expiry.
It never creates a WooCommerce order. An authenticated operator must create or
refresh payment options. Checkout requires both the valid opaque service
reference and a matching active payment ID, then redirects to the fixed
WooCommerce order-pay URL. Invalid, archived, expired, and mismatched references
receive the same bounded unavailable page.

The Account view can rotate the public-reference key with an audited reason and
a 24-2160 hour overlap. The prior key is stored mode `0600` in
`public-reference.previous.json` and resolves existing URLs only until its
expiry. A second rotation is blocked during that window. The UI/API disclose
only key fingerprints and timestamps; global app-data backups retain both key
files.

The Reminders view also includes payment-option reconciliation. Its daily
schedule defaults off, manual execution requires `CREATE`, and preview performs
no WooCommerce writes. Eligible services must be non-archived, have a positive
configured price and paid-through date, and be in reminder, grace, or suspended
state. Existing active options are never duplicated. An exact expired option
is refreshed only after WooCommerce confirms its old order is cancelled;
overlapping expired selections are blocked for manual review. Each run records
created, failed, blocked, and deferred counts in the billing audit. Runs are
limited to 10 WooCommerce orders to bound provider load and request duration.
Failed candidates remain eligible for the next controlled run. When a valid
service has no active payment option, the renewal page shows the optional
validated HTTPS support link and bounded label from WooCommerce settings.
Invalid renewal references keep the generic unavailable page.

Configure a WooCommerce **Order updated** webhook:

```text
Delivery URL: https://billing.example.com/webhooks/woocommerce
Secret: the exact webhook secret saved in Billing
```

The handler accepts signed `order.created` and `order.updated` deliveries.
`processing` or `completed` extends only the selected service dates when order
ID, amount, and currency match. Delivery IDs and payment state make callbacks idempotent.
Forged, replayed, mismatched, expired, refunded, cancelled, and failed cases do
not silently extend or shorten service. Ambiguous paid, refund, chargeback, and
failure outcomes persist a visible manual-review reason on the payment. A
mismatched paid callback also disables the still-pending public link. Operators
can acknowledge the review with a required audited resolution note, but that
action never changes payment status or renewal dates. A matching cancellation
callback for an order already cancelled through Billing is recorded without a
false review alert.

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

`POST /internal/v1/services` uses the same bearer credential but accepts only
bounded provisioning fields and a required `Idempotency-Key`. It creates a
local, enforcement-disabled billing record after successful website
provisioning. Repeating a request for the same normalized primary domain
returns the existing stable service without changing manually edited billing
data. It does not expose list, update, archive, payment, or contact-reading
operations.

The hosting panel stores its non-secret defaults in
`app-data/ui-manager/billing-provisioning-settings.json`. Defaults start
disabled and use 6 free months, a 12-month USD 80 hosting renewal, a 12-month
domain period, and 7 grace days. Provision, import, and backup-restore forms
retain a per-site choice. Imports and restores default to no registration and
no free period. Restore registration runs only after the validated website and
database restore succeeds. A registration outage becomes a job warning and
never rolls back the working website.

Jobs with that specific warning expose **Retry billing**. The retry is a
separate durable job that reconstructs the original bounded registration,
reuses the original provision/restore idempotency key and trial anchor, and does
not touch website files, databases, DNS, NPM, or certificates. A successful
linked retry removes the action from the source job.

`hosting-ui` includes that consumer and a separate local reconciler. Under
**Settings > Billing entitlement observer**, an operator can manually refresh
or enable scheduled verification. The observer:

- uses only the internal `BILLING_API_URL` and `BILLING_API_TOKEN`;
- verifies the exact response HMAC with a timing-safe comparison;
- rejects stale, future, malformed, duplicated, or unsupported services;
- atomically retains the last verified snapshot in panel data;
- compares canonical billing domains and aliases with local primary websites;
- rejects ambiguous cross-service domain ownership and invalid renewal URLs;
- reports matches and inventory drift before enforcement is considered.

**Settings > Billing enforcement pilot** owns the hosting-side nginx map. The
global switch defaults off and its pilot allowlist defaults empty. It redirects
only when the local site, signed ownership, fresh `suspended` state,
`payment_page` policy, and signed HTTPS renewal URL all match. Candidate maps
are written atomically, checked with `nginx -t`, and rolled back on reload
failure. **Disable and restore all** turns off the switch and immediately
empties the map without changing billing dates or website data. A one-minute
freshness watchdog clears entries when signed state becomes stale or
unavailable. Proposed and applied block/restore transitions are retained in a
bounded audit without payment URLs or customer data. Nginx apply or rollback
failures enqueue a critical operator alert through the panel's configured
Telegram and SMTP channels.

On the first valid `processing` or `completed` delivery that changes a payment
to paid, billing sends only the WooCommerce delivery ID to the internal
`/internal/v1/billing-entitlements/refresh` panel endpoint. The panel fetches
and verifies the complete signed feed itself, then reconciles if enforcement is
enabled. The callback retries transient failures without changing the durable
payment result. Scheduled observation is mandatory while enforcement is
enabled and remains the recovery fallback if every callback attempt fails.

`payment_page` is accepted only for services whose location is **Local stack**.
The shared-hosting and notification-only locations reject it in API and CSV
validation, and the editor disables the option. Remote services remain
notification-only until a separately qualified adapter exists.

Billing still has no nginx, Docker, website, or panel-data access. Only
`hosting-ui` owns the narrow map and uses the allowlisted control agent for
nginx validation/reload. New installations retain an empty allowlist. Add only
one explicitly reviewed local pilot at a time and complete the qualification
and rollback work in `TODO.md` before expanding it.

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
and replay protection, renewal states, optimistic-concurrency CRUD, archive
and restore, migrations, transactions, audit, backup, restore, and the live
HTTP contract.

### Local enforcement pilot qualification

After an operator has deliberately configured one local pilot, run the
read-only qualification from the source directory:

```bash
sudo ./scripts/qualify-billing-pilot.sh \
  --domain test.example.com \
  --billing-url https://billing.example.com \
  --expected-state suspended
```

The script requires exactly one pilot hostname. It checks container health,
local `payment_page` policy, the expected calculated state, a fresh signed
entitlement observation, the applied nginx map, an active payment matching the
configured hosting price, the public renewal page, `noindex`, `no-store`,
anti-framing, referrer and CSP headers, and the final WooCommerce checkout
redirect. It does not print opaque renewal/payment references and does not
mutate billing, orders, nginx, DNS, or website data.

Repeat it with `active`, `reminder`, `grace`, and `exempt` during the state
drill. Those states must be absent from the nginx map and must remain publicly
unblocked. Passing this script is bounded evidence for one state; it does not
replace the completed-payment, duplicate-callback, outage, rollback, and
automatic-restoration drills in `TODO.md`. Follow
`docs/BILLING_PILOT_RUNBOOK.md` for their ordered pass/fail checklist.
