# WordPress Cache Control

Hosting Control packages a versioned must-use plugin at
`ui-manager/app/wordpress/hosting-cache-control.php`. Fresh WordPress
provisioning, browser imports, and portable imports install it automatically.
Existing sites are updated from **Maintenance > WordPress cache controls**.

Administrators also receive a native **Cache** menu in the WordPress toolbar
on wp-admin and the public website. Its FastCGI, OPcache, Redis, Cloudflare,
and Purge all actions use the same capability check, nonce, and site-scoped
AJAX handler as the Tools page. The MU plugin disables Redis Object Cache's
separate toolbar item to avoid two controls for the same object cache; the
Redis plugin and object-cache drop-in remain enabled.

## Security Boundary

Each canonical WordPress site receives a random 256-bit credential in
`wp-content/mu-plugins/hosting-cache-control-config.php`. The panel stores only
its SHA-256 hash in `app-data/ui-manager/wordpress-cache-control.json`. A site
credential authenticates only that exact canonical WordPress domain at the
internal `hosting-ui` endpoint; it grants no browser session, Docker, Redis,
Cloudflare, billing, or general panel authority. Rotation immediately rejects
the prior credential.

The WordPress AJAX action requires `manage_options` and a WordPress nonce. No
`nopriv`, public REST, or query-string credential endpoint exists. Panel calls
are rate limited and their bounded audit contains no token values.

## Layer Behavior

- **FastCGI** increments only the selected site's cache generation and reloads
  validated nginx state transactionally.
- **OPcache** invalidates at most 5,000 PHP files whose real paths remain below
  the current `ABSPATH`; it never calls `opcache_reset()`.
- **Redis** uses `WP_REDIS_PREFIX=<domain>:` and
  `WP_REDIS_SELECTIVE_FLUSH=true`, then flushes that namespace through
  WordPress.
- **Cloudflare** asks the panel's separate Cloudflare Security integration to
  purge the matching zone. Missing permissions fail only this layer.
- **Purge all** runs every layer and reports each result independently.

## Removal And Recovery

The authenticated panel removal API deletes only
`hosting-cache-control.php` and `hosting-cache-control-config.php` from the
selected site's `mu-plugins` directory and removes its stored hash. Reinstall
with credential rotation to repair a missing config file. Removing the plugin
does not alter WordPress content, themes, ordinary plugins, databases, cache
configuration, or the separate billing plugin.
