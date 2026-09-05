# Hosting Fencing Witness

This Cloudflare Worker provides the independent lease gate used by the hosting
HA scripts. A SQLite-backed Durable Object serializes all decisions.

## Deploy

1. Install dependencies with `npm install`.
2. Authenticate Wrangler to the intended Cloudflare account.
3. Add four independent random secrets with at least 32 characters:

   ```sh
   npx wrangler secret put PRIMARY_TOKEN
   npx wrangler secret put STANDBY_TOKEN
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put SIGNING_KEY
   ```

4. Run `npm test`, then `npx wrangler deploy`.
5. Bind a dedicated hostname or use the generated `workers.dev` URL.

The primary token belongs only on OPI5. The standby token and signing key
belong only on HP. Keep the administrator token on an operator workstation.
The signing key is shared only because the existing receipt verifier uses
HMAC-SHA256.

## Protocol

- `POST /v1/lease` renews the current primary's 90-second lease.
- `POST /v1/fence` refuses while that lease is active and otherwise returns a
  signed ten-minute receipt bound to a newer recovery point.
- `POST /v1/reset` clears fencing after controlled rebuild/failback.
- `GET /health` is a non-secret liveness response.

All responses use `Cache-Control: no-store`. The Worker stores identifiers and
timestamps, never bearer tokens or the signing key.
