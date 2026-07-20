global-configs-new (FULL) — one PHP-FPM + one nginx-internal for all sites

This archive is generated from your compose snippet paths.
Assumptions:
- Normal domains use folder /var/www/<domain>
- example.org is split into two sites: www.example.org -> /var/www/example.org/www, pp.example.org -> /var/www/example.org/pp
- example.net subfolders are subdomains:
  prettypenmanship.example.net -> /var/www/example.net/prettypenmanship
  qualitymoverentals.example.net -> /var/www/example.net/qualitymoverentals
  thetaeaffect.example.net -> /var/www/example.net/thetaeaffect
- If any hostname differs in NPM, edit: nginx/conf.d/sites.map

Files:
- php/global.ini             (global PHP settings)
- wp/wp-global.php           (global WP tweaks via auto_prepend_file)
- php-fpm/pools.conf         (ALL pools in ONE file, minimal per site)
- nginx/nginx.conf           (global nginx)
- nginx/conf.d/sites.map     (host -> root and host -> php upstream)
- nginx/conf.d/default.conf  (single server config for all)

IMPORTANT:
- Create an empty folder for default root: /media/ssdmount/websites/_default (or change default in sites.map)
