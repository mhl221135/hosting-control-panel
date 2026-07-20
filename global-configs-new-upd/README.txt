Versioned runtime configuration templates

Fresh installations copy these templates to app-data/configs. The control panel
then manages the active copies. Upgrades do not replace active configuration.

Files:
- php/global.ini             Global PHP and OPcache settings
- wp/wp-global.php           Shared WordPress runtime settings
- php-fpm/php-fpm.conf       PHP-FPM process configuration
- php-fpm/pools.conf         Default pool; provisioned site pools are added here
- nginx/nginx.conf           Global internal nginx configuration
- nginx/conf.d/sites.map     Domain roots, PHP upstreams, and canonical hosts
- nginx/conf.d/cache.map     Per-site FastCGI cache state
- nginx/conf.d/default.conf  Shared website server configuration

Create an empty `_default` directory under the configured websites root.
