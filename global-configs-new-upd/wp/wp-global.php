<?php

/**
 * Global WP config logic shared by all websites (loaded via auto_prepend_file)
 */

// Reasonable defaults for Elementor/WooCommerce. You can override per-site in wp-config.php if needed.
/*
if (!defined('WP_MEMORY_LIMIT')) define('WP_MEMORY_LIMIT', '256M');
if (!defined('WP_MAX_MEMORY_LIMIT')) define('WP_MAX_MEMORY_LIMIT', '512M');

if (!defined('WP_DEBUG')) define('WP_DEBUG', false);
if (!defined('WP_DEBUG_LOG')) define('WP_DEBUG_LOG', false);
if (!defined('WP_DEBUG_DISPLAY')) define('WP_DEBUG_DISPLAY', false);
*/
// Force HTTPS when behind Nginx Proxy Manager / Cloudflare
if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {
    $_SERVER['HTTPS'] = 'on';
    $_SERVER['SERVER_PORT'] = 443;
    $_SERVER['REQUEST_SCHEME'] = 'https';
}

/*
define('XMLRPC_REQUEST', false);*/



// Only run this on actual webpage requests (not API or Command Line)
if (php_sapi_name() !== 'cli' && !isset($_GET['wc-api'])) {
    ob_start(function($html_buffer) {
        // Search for the closing </head> tag and insert our CSS right before it
        if (stripos($html_buffer, '</head>') !== false) {
            $css = "<style>.alignwide { margin-inline: 0px !important; }</style>";
            $html_buffer = str_ireplace('</head>', $css . "\n</head>", $html_buffer);
        }
        return $html_buffer;
    });
}
