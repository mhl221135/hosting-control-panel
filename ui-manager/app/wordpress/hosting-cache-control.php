<?php
/**
 * Plugin Name: Hosting Cache Control
 * Description: Site-scoped cache controls managed by Hosting Control.
 * Version: 1.0.0
 */

if (!defined('ABSPATH')) exit;
$hosting_cache_config = __DIR__ . '/hosting-cache-control-config.php';
if (is_readable($hosting_cache_config)) require_once $hosting_cache_config;

function hosting_cache_control_local_opcache() {
    if (!function_exists('opcache_invalidate')) return array('ok' => true, 'message' => 'OPcache is unavailable', 'files' => 0);
    $root = realpath(ABSPATH);
    if (!$root) return array('ok' => false, 'message' => 'WordPress root is unavailable', 'files' => 0);
    $files = 0;
    $invalidated = 0;
    $failed = 0;
    try {
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
        foreach ($iterator as $entry) {
            if ($files >= 5000) break;
            if (!$entry->isFile() || strtolower($entry->getExtension()) !== 'php') continue;
            $real = $entry->getRealPath();
            if (!$real || ($real !== $root && strpos($real, $root . DIRECTORY_SEPARATOR) !== 0)) continue;
            $files++;
            if (function_exists('opcache_is_script_cached') && !opcache_is_script_cached($real)) continue;
            if (@opcache_invalidate($real, true)) $invalidated++; else $failed++;
        }
    } catch (Throwable $error) {
        return array('ok' => false, 'message' => 'OPcache scan failed', 'files' => $files, 'invalidated' => $invalidated, 'failed' => $failed);
    }
    return array('ok' => $failed === 0, 'message' => sprintf('Scanned %d PHP files; invalidated %d; failed %d', $files, $invalidated, $failed), 'files' => $files, 'invalidated' => $invalidated, 'failed' => $failed);
}

function hosting_cache_control_redis() {
    if (!defined('WP_REDIS_PREFIX') || !WP_REDIS_PREFIX) return array('ok' => true, 'message' => 'Site Redis namespace is not configured');
    $result = wp_cache_flush();
    return array('ok' => (bool) $result, 'message' => $result ? 'Site object cache flushed' : 'Object cache flush failed');
}

function hosting_cache_control_remote($layers) {
    if (!defined('HOSTING_CACHE_CONTROL_ENDPOINT') || !defined('HOSTING_CACHE_CONTROL_TOKEN') || !defined('HOSTING_CACHE_CONTROL_DOMAIN')) {
        return array('ok' => false, 'message' => 'Panel cache-control enrollment is missing');
    }
    $response = wp_remote_post(HOSTING_CACHE_CONTROL_ENDPOINT, array(
        'timeout' => 20,
        'headers' => array('Authorization' => 'Bearer ' . HOSTING_CACHE_CONTROL_TOKEN, 'Content-Type' => 'application/json'),
        'body' => wp_json_encode(array('domain' => HOSTING_CACHE_CONTROL_DOMAIN, 'layers' => array_values($layers))),
    ));
    if (is_wp_error($response)) return array('ok' => false, 'message' => $response->get_error_message());
    $body = json_decode(wp_remote_retrieve_body($response), true);
    if (wp_remote_retrieve_response_code($response) >= 300 || !is_array($body)) {
        return array('ok' => false, 'message' => 'Panel cache purge failed');
    }
    return $body;
}

function hosting_cache_control_ajax() {
    if (!current_user_can('manage_options')) wp_send_json_error(array('message' => 'Administrator access required'), 403);
    check_ajax_referer('hosting-cache-control', 'nonce');
    $layer = sanitize_key(isset($_POST['layer']) ? wp_unslash($_POST['layer']) : '');
    if (!in_array($layer, array('fastcgi', 'opcache', 'redis', 'cloudflare', 'all'), true)) {
        wp_send_json_error(array('message' => 'Cache layer is invalid'), 400);
    }
    $results = array();
    if ($layer === 'opcache' || $layer === 'all') $results['opcache'] = hosting_cache_control_local_opcache();
    if ($layer === 'redis' || $layer === 'all') $results['redis'] = hosting_cache_control_redis();
    $remote_layers = $layer === 'all' ? array('fastcgi', 'cloudflare') : (in_array($layer, array('fastcgi', 'cloudflare'), true) ? array($layer) : array());
    if ($remote_layers) {
        $remote = hosting_cache_control_remote($remote_layers);
        foreach ((array) ($remote['results'] ?? array()) as $name => $result) $results[$name] = $result;
        if (empty($remote['ok']) && empty($remote['results'])) $results['panel'] = array('ok' => false, 'message' => $remote['message'] ?? 'Panel cache purge failed');
    }
    $ok = !array_filter($results, function ($result) { return empty($result['ok']); });
    wp_send_json_success(array('ok' => $ok, 'results' => $results));
}
add_action('wp_ajax_hosting_cache_control_purge', 'hosting_cache_control_ajax');

function hosting_cache_control_page() {
    add_management_page('Hosting cache', 'Hosting cache', 'manage_options', 'hosting-cache-control', 'hosting_cache_control_render');
}
add_action('admin_menu', 'hosting_cache_control_page');

function hosting_cache_control_render() {
    if (!current_user_can('manage_options')) return;
    $nonce = wp_create_nonce('hosting-cache-control');
    ?>
    <div class="wrap"><h1>Hosting cache</h1><p>Clear cache for this website only.</p>
      <div id="hosting-cache-actions">
        <button class="button" data-layer="fastcgi">FastCGI</button>
        <button class="button" data-layer="opcache">OPcache</button>
        <button class="button" data-layer="redis">Redis</button>
        <button class="button" data-layer="cloudflare">Cloudflare</button>
        <button class="button button-primary" data-layer="all">Purge all</button>
      </div><div id="hosting-cache-result" style="margin-top:16px"></div>
    </div>
    <script>
    (() => { const root=document.getElementById('hosting-cache-actions'), out=document.getElementById('hosting-cache-result'); root.addEventListener('click', async (event) => { const button=event.target.closest('button[data-layer]'); if(!button)return; button.disabled=true; out.textContent='Clearing cache...'; const body=new URLSearchParams({action:'hosting_cache_control_purge',nonce:<?php echo wp_json_encode($nonce); ?>,layer:button.dataset.layer}); try { const response=await fetch(ajaxurl,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body}); const data=await response.json(); const results=data.data?.results||{}; out.innerHTML=Object.entries(results).map(([name,result])=>`<p><strong>${name}</strong>: ${result.ok?'Complete':'Failed'} - ${String(result.message||'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}</p>`).join('') || '<p>Nothing changed.</p>'; } catch(error) { out.textContent='Cache request failed.'; } finally { button.disabled=false; } }); })();
    </script>
    <?php
}
