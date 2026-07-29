#!/usr/bin/env bash

set -Eeuo pipefail

domain=""
billing_url=""
expected_state="suspended"
billing_container="hosting-billing"
ui_container="hosting-ui"
nginx_container="hosting-nginx"
temporary=""

usage() {
  cat <<'EOF'
Usage: qualify-billing-pilot.sh --domain HOST --billing-url HTTPS_URL [options]

Read-only qualification for one explicitly selected local billing pilot.
It validates billing policy, the fresh signed observation, exact allowlisting,
nginx enforcement, the public renewal page, and WooCommerce checkout routing.
Opaque renewal/payment references and credentials are never printed.

Options:
  --domain HOST             Exact primary local website hostname
  --billing-url HTTPS_URL   Public billing origin, without a path
  --expected-state STATE    active|reminder|grace|suspended|exempt
                            (default: suspended)
  --billing-container NAME  Billing container (default: hosting-billing)
  --ui-container NAME       Panel container (default: hosting-ui)
  --nginx-container NAME    Internal nginx container (default: hosting-nginx)
  --help                    Show this help

Suspended qualification requires an active hosting payment option and an exact
public redirect. Other states require the site to remain publicly unblocked.
The script does not update billing data, orders, nginx, DNS, or website files.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain) domain="${2:-}"; shift 2 ;;
    --billing-url) billing_url="${2:-}"; shift 2 ;;
    --expected-state) expected_state="${2:-}"; shift 2 ;;
    --billing-container) billing_container="${2:-}"; shift 2 ;;
    --ui-container) ui_container="${2:-}"; shift 2 ;;
    --nginx-container) nginx_container="${2:-}"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 64 ;;
  esac
done

valid_domain='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
[[ "$domain" =~ $valid_domain ]] && [ "${#domain}" -le 253 ] || {
  printf '%s\n' '--domain must be a lowercase fully qualified hostname.' >&2
  exit 64
}
[[ "$billing_url" =~ ^https://[a-z0-9.-]+(:[0-9]{1,5})?$ ]] || {
  printf '%s\n' '--billing-url must be an HTTPS origin without a path.' >&2
  exit 64
}
case "$expected_state" in
  active|reminder|grace|suspended|exempt) ;;
  *) printf '%s\n' '--expected-state is invalid.' >&2; exit 64 ;;
esac
for name in "$billing_container" "$ui_container" "$nginx_container"; do
  [[ "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]] || {
    printf '%s\n' 'Container names contain unsupported characters.' >&2
    exit 64
  }
done
for command in curl docker jq awk grep sed mktemp; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Required command is missing: %s\n' "$command" >&2
    exit 1
  }
done

temporary="$(mktemp -d "${TMPDIR:-/tmp}/hosting-billing-pilot.XXXXXX")"
cleanup() {
  [ -n "$temporary" ] && rm -rf -- "$temporary"
}
trap cleanup EXIT HUP INT TERM

record() {
  printf 'PASS %s\n' "$1"
}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]
}

printf 'Billing enforcement pilot qualification\n'
printf '%s\n' '======================================='

for container in "$billing_container" "$ui_container" "$nginx_container"; do
  container_running "$container" || {
    printf 'Required container is not running.\n' >&2
    exit 1
  }
done
record "required containers are running"

docker exec "$billing_container" node --no-warnings -e '
  const { BillingDatabase } = require("./app/lib/database");
  const { WooCommerceSettings } = require("./app/lib/woocommerce-settings");
  const selected = process.argv[1];
  const database = new BillingDatabase(process.env.DATA_DIR || "/app/data");
  try {
    const matches = database.services({ archived: "all" })
      .filter((service) => service.primary_domain === selected);
    if (matches.length !== 1) throw new Error("Expected exactly one billing service");
    const service = matches[0];
    const payments = database.publicPayments(service.service_id);
    const woo = new WooCommerceSettings(process.env.DATA_DIR || "/app/data").public();
    console.log(JSON.stringify({
      service: {
        archived: service.archived,
        location: service.location,
        state: service.hosting_state,
        enforcementMode: service.enforcement_mode,
        priceMinor: service.hosting_price_minor,
        currency: service.currency,
      },
      payments,
      woo: { ready: woo.ready, siteUrl: woo.siteUrl },
    }));
  } finally {
    database.close();
  }
' "$domain" >"$temporary/billing.json"

jq -e --arg state "$expected_state" '
  .service.archived == false
  and .service.location == "local"
  and .service.enforcementMode == "payment_page"
  and .service.state == $state
  and (.service.priceMinor | type == "number" and . > 0)
  and (.service.currency | test("^[A-Z]{3}$"))
  and .woo.ready == true
  and (.woo.siteUrl | test("^https://"))
' "$temporary/billing.json" >/dev/null || {
  printf 'Billing service policy or WooCommerce readiness check failed.\n' >&2
  exit 1
}
record "billing service is local, eligible, and in the expected state"

docker exec "$ui_container" node --no-warnings -e '
  const fs = require("fs");
  const path = require("path");
  const selected = process.argv[1];
  const data = process.env.DATA_DIR || "/app/data";
  const read = (name) => JSON.parse(fs.readFileSync(path.join(data, name), "utf8"));
  const observer = read("billing-observer-settings.json");
  const enforcement = read("billing-enforcement-settings.json");
  const status = read("billing-enforcement-status.json");
  const snapshot = read("billing-entitlements-lkg.json");
  const match = snapshot.matches.filter((item) => item.localDomain === selected);
  const ageSeconds = Math.floor((Date.now() - Date.parse(snapshot.payload.generatedAt)) / 1000);
  console.log(JSON.stringify({
    observer: {
      enabled: observer.enabled,
      maxSnapshotAgeSeconds: observer.maxSnapshotAgeSeconds,
    },
    enforcement: {
      enabled: enforcement.enabled,
      exactPilot: enforcement.pilotDomains.length === 1 && enforcement.pilotDomains[0] === selected,
    },
    status: {
      result: status.result,
      blocked: status.blockedHosts.includes(selected),
    },
    snapshot: {
      generatedAt: snapshot.payload.generatedAt,
      fresh: Number.isFinite(ageSeconds)
        && ageSeconds >= -60
        && ageSeconds <= observer.maxSnapshotAgeSeconds,
      matchCount: match.length,
      state: match[0]?.state || "",
      enforcementMode: match[0]?.enforcementMode || "",
      renewalUrlValid: /^https:\/\/[^/]+\/renew\/r1_[A-Za-z0-9_-]{43}$/.test(match[0]?.renewalUrl || ""),
    },
  }));
' "$domain" >"$temporary/panel.json"

jq -e --arg state "$expected_state" '
  .observer.enabled == true
  and (.observer.maxSnapshotAgeSeconds | type == "number" and . >= 30)
  and .enforcement.enabled == true
  and .enforcement.exactPilot == true
  and .snapshot.fresh == true
  and .snapshot.matchCount == 1
  and .snapshot.state == $state
  and .snapshot.enforcementMode == "payment_page"
  and .snapshot.renewalUrlValid == true
' "$temporary/panel.json" >/dev/null || {
  printf 'Signed observation, exact pilot allowlist, or policy match failed.\n' >&2
  exit 1
}

record "scheduled signed entitlement observation is fresh"
record "global enforcement is limited to the exact selected pilot"

docker exec "$nginx_container" nginx -t >/dev/null 2>&1 || {
  printf 'Internal nginx configuration validation failed.\n' >&2
  exit 1
}
docker cp "$nginx_container:/etc/nginx/conf.d/billing-enforcement.map" "$temporary/enforcement.map" >/dev/null
escaped_domain="${domain//./\\.}"
map_present=false
if grep -Eq "^[[:space:]]*${escaped_domain}[[:space:]]+\"https://[^/]+/renew/r1_[A-Za-z0-9_-]{43}\";[[:space:]]*$" \
  "$temporary/enforcement.map"; then
  map_present=true
fi

if [ "$expected_state" = "suspended" ]; then
  if [ "$map_present" != true ] || ! jq -e '.status.result == "applied" and .status.blocked == true' \
    "$temporary/panel.json" >/dev/null; then
    printf 'Suspended pilot is not present in the applied nginx map.\n' >&2
    exit 1
  fi
else
  if [ "$map_present" != false ] || ! jq -e '.status.blocked == false' "$temporary/panel.json" >/dev/null; then
    printf 'A non-suspended pilot remains in the applied nginx map.\n' >&2
    exit 1
  fi
fi
record "nginx configuration and expected enforcement map state are valid"

curl_common=(--silent --show-error --max-time 20 --connect-timeout 7 --proto '=https')
curl "${curl_common[@]}" -D "$temporary/site.headers" -o "$temporary/site.body" "https://$domain/"
site_status="$(awk 'NR == 1 { print $2 }' "$temporary/site.headers")"
site_location="$(awk 'tolower($1) == "location:" { sub(/\r$/, "", $2); print $2; exit }' "$temporary/site.headers")"

if [ "$expected_state" != "suspended" ]; then
  case "$site_status" in 200|301|302|303|307|308) ;; *)
    printf 'Non-suspended pilot returned an unexpected public status.\n' >&2
    exit 1
  esac
  [[ "$site_location" != "$billing_url"/renew/* ]] || {
    printf 'Non-suspended pilot still redirects to billing.\n' >&2
    exit 1
  }
  record "non-suspended pilot remains publicly unblocked"
  printf '\nQualification passed without modifying production state.\n'
  exit 0
fi

[ "$site_status" = "302" ] && [[ "$site_location" =~ ^${billing_url}/renew/r1_[A-Za-z0-9_-]{43}$ ]] || {
  printf 'Suspended pilot did not return the exact protected renewal redirect.\n' >&2
  exit 1
}
record "public website redirects to its protected renewal page"

jq -e '
  . as $root
  | [.payments[] | select(
    .selection == "hosting"
    and .amount_minor == $root.service.priceMinor
    and .currency == $root.service.currency
    and .hosting_months > 0
  )] | length >= 1
' "$temporary/billing.json" >/dev/null || {
  printf 'No active hosting payment matches the configured service price.\n' >&2
  exit 1
}
amount_minor="$(jq -r .service.priceMinor "$temporary/billing.json")"
amount="$(awk -v amount="$amount_minor" 'BEGIN { printf "%.2f", amount / 100 }')"

curl "${curl_common[@]}" -D "$temporary/renewal.headers" -o "$temporary/renewal.html" "$site_location"
renewal_status="$(awk 'NR == 1 { print $2 }' "$temporary/renewal.headers")"
[ "$renewal_status" = "200" ] || { printf 'Renewal page did not return HTTP 200.\n' >&2; exit 1; }
if ! grep -Fq "$amount" "$temporary/renewal.html" \
  || ! grep -Fq "Pay securely" "$temporary/renewal.html" \
  || ! grep -Eiq '^cache-control:[[:space:]]*no-store([[:space:]]|$)' "$temporary/renewal.headers" \
  || ! grep -Eiq '^content-security-policy:.*frame-ancestors[[:space:]]+'\''none'\''' "$temporary/renewal.headers" \
  || ! grep -Eiq '^referrer-policy:[[:space:]]*no-referrer([[:space:]]|$)' "$temporary/renewal.headers" \
  || ! grep -Eiq '^x-frame-options:[[:space:]]*deny([[:space:]]|$)' "$temporary/renewal.headers" \
  || ! grep -Eiq '^x-robots-tag:[[:space:]]*noindex' "$temporary/renewal.headers"; then
  printf 'Renewal page content or required security headers are missing.\n' >&2
  exit 1
fi
record "renewal page exposes the matching amount and required security headers"

checkout_path="$(sed -n 's/.*href="\([^"]*\/checkout\/[^"]*\)".*/\1/p' "$temporary/renewal.html" | head -n 1)"
[[ "$checkout_path" =~ ^/renew/r1_[A-Za-z0-9_-]{43}/checkout/[A-Za-z0-9-]{16,64}$ ]] || {
  printf 'Renewal page checkout path is invalid.\n' >&2
  exit 1
}
curl "${curl_common[@]}" -D "$temporary/checkout.headers" -o /dev/null "$billing_url$checkout_path"
checkout_status="$(awk 'NR == 1 { print $2 }' "$temporary/checkout.headers")"
checkout_location="$(awk 'tolower($1) == "location:" { sub(/\r$/, "", $2); print $2; exit }' "$temporary/checkout.headers")"
woo_origin="$(jq -r .woo.siteUrl "$temporary/billing.json")"
[ "$checkout_status" = "302" ] && [[ "$checkout_location" == "$woo_origin"/checkout/order-pay/* ]] || {
  printf 'Checkout did not redirect to the configured WooCommerce store.\n' >&2
  exit 1
}
record "checkout resolves to the configured WooCommerce store"

printf '\nQualification passed without modifying production state.\n'
