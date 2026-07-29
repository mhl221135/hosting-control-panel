# Billing Pilot Runbook

Use this runbook only for one disposable or explicitly authorized local pilot.
Do not add another hostname to the allowlist while a drill is in progress.

## Safety Boundary

- Keep a current billing backup and a verified source backup.
- Record the pilot service ID, expected state, and test order ID in private
  operator notes. Do not paste renewal references, order keys, tokens, customer
  details, or production URLs into Git.
- Keep global enforcement off until observation-only checks pass.
- Never test suspension by deleting files, changing WordPress URLs, disabling
  NPM, or altering the website database.
- Stop on an ambiguous domain match, stale snapshot, failed `nginx -t`, or
  unexpected redirect.

## Preconditions

1. Select one local-stack service with `payment_page` enforcement.
2. Confirm its hosting price, currency, paid-through date, grace policy, and
   WooCommerce renewal product.
3. Confirm the billing observer is enabled and its signed snapshot is fresh.
4. Set the pilot allowlist to exactly that one primary hostname.
5. Run the read-only gate:

   ```bash
   sudo ./scripts/qualify-billing-pilot.sh \
     --domain test.example.com \
     --billing-url https://billing.example.com \
     --expected-state suspended
   ```

6. Save only the PASS/FAIL output. The command omits protected renewal and
   checkout references.

## State Drill

Exercise each state separately. Refresh signed entitlements after each billing
change and rerun the qualifier with the matching `--expected-state`.

| State | Required public result | Nginx map |
| --- | --- | --- |
| `active` | Website remains available | Host absent |
| `reminder` | Website remains available | Host absent |
| `grace` | Website remains available | Host absent |
| `exempt` | Website remains available | Host absent |
| `suspended` | HTTP 302 to the protected renewal page | Host present once |

For `suspended`, also confirm the configured amount and period, required
security headers, WooCommerce checkout redirect, operator administration
access, and immediate recovery through **Disable and restore all**.

## Payment And Webhook Drill

Use a test payment method or an order that cannot charge a real customer.

1. Create one hosting-only renewal for the configured amount and currency.
2. Complete checkout and deliver a `processing` or `completed` webhook.
3. Confirm one immutable delivery record and one paid payment transition.
4. Confirm the hosting paid-through date advances by the selected period.
5. Confirm the entitlement callback restores the website without manual nginx,
   NPM, DNS, filesystem, or database edits.
6. Confirm scheduled observation produces the same restored state.

Record the order number, webhook delivery ID, old/new paid-through dates,
restore timestamp, and PASS/FAIL result only in private operator notes.

## Negative Payment Cases

- Deliver the same valid webhook twice. The date must advance once.
- Deliver an expired or replayed payment reference. It must be rejected.
- Deliver the wrong amount or currency. It must enter manual review and must
  not restore the site.
- Deliver an unsupported webhook topic. It must be rejected.
- Exercise refund and chargeback handling. It must be audited and must never
  delete website data.
- Make WooCommerce unavailable before checkout. The renewal page must remain
  safe and expose no credentials.

## Outage And Recovery Drill

Run one fault at a time and restore it before proceeding:

1. Stop billing while the pilot is active. Stale state must fail open.
2. Interrupt the refresh callback after payment. Scheduled polling must restore
   the site after billing recovers.
3. Restart the panel. Stale state must not newly suspend a site.
4. Test candidate nginx validation failure only in an isolated fixture. The
   previous map must remain active and a critical alert must be queued.
5. Disable global enforcement while suspended. The map must become empty and
   the public site must recover immediately.
6. Let the snapshot exceed its freshness limit. The watchdog must clear the
   suspended mapping and alert the operator.

Do not inject an invalid nginx configuration into production for this drill.

## Completion Gate

The pilot passes only when:

- every state has the expected public and map behavior;
- payment advances the correct date exactly once;
- restoration works through callback and polling paths;
- stale, invalid, unavailable, or ambiguous state fails open;
- rollback works without website-data changes;
- alerts contain no protected URLs, credentials, or customer data;
- billing, panel, and nginx audit timelines agree.

After success, remove the pilot hostname from the allowlist and disable global
enforcement until a deliberate production rollout is approved.
