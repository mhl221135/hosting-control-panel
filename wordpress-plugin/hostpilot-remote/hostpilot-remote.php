<?php
/**
 * Plugin Name: HostPilot Remote Billing
 * Description: Fail-open enrollment and signed hosting entitlement checks for remotely hosted WordPress sites.
 * Version: 0.1.0
 * Requires at least: 6.4
 * Requires PHP: 8.1
 * Author: HostPilot
 */

if (!defined('ABSPATH')) {
    exit;
}

require_once __DIR__ . '/includes/class-hostpilot-contract.php';

final class HostPilot_Remote_Billing {
    private const CONFIG = 'hostpilot_remote_config';
    private const STATUS = 'hostpilot_remote_status';
    private const ENTITLEMENT = 'hostpilot_remote_entitlement';
    private const CRON = 'hostpilot_remote_poll';
    private const LOCK = 'hostpilot_remote_poll_lock';

    public static function init(): void {
        add_filter('cron_schedules', array(__CLASS__, 'cron_schedules'));
        add_action('init', array(__CLASS__, 'ensure_schedule'));
        add_action(self::CRON, array(__CLASS__, 'poll'));
        add_action('admin_menu', array(__CLASS__, 'admin_menu'));
        add_filter('debug_information', array(__CLASS__, 'site_health'));
    }

    public static function activate(): void {
        self::ensure_schedule();
    }

    public static function ensure_schedule(): void {
        if (is_multisite()) {
            return;
        }
        if (!wp_next_scheduled(self::CRON)) {
            wp_schedule_event(time() + random_int(60, 600), 'hostpilot_fifteen_minutes', self::CRON);
        }
    }

    public static function deactivate(): void {
        wp_clear_scheduled_hook(self::CRON);
        delete_transient(self::LOCK);
    }

    public static function cron_schedules(array $schedules): array {
        $schedules['hostpilot_fifteen_minutes'] = array('interval' => 900, 'display' => 'Every 15 minutes');
        return $schedules;
    }

    private static function normalize_domain(string $value): string {
        return strtolower(rtrim(trim($value), '.'));
    }

    private static function valid_server(string $value): string {
        $url = untrailingslashit(esc_url_raw(trim($value)));
        $parts = wp_parse_url($url);
        return strpos($url, 'https://') === 0 && wp_http_validate_url($url) && is_array($parts)
            && empty($parts['user']) && empty($parts['pass']) && empty($parts['fragment']) ? $url : '';
    }

    private static function encryption_key(): string {
        return hash('sha256', AUTH_KEY . SECURE_AUTH_KEY, true);
    }

    private static function encrypt(string $credential): array {
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        return array(
            'credential' => base64_encode(sodium_crypto_secretbox($credential, $nonce, self::encryption_key())),
            'nonce' => base64_encode($nonce),
        );
    }

    private static function credential(array $config): string {
        if (!function_exists('sodium_crypto_secretbox_open')) {
            return '';
        }
        $box = base64_decode((string) ($config['credential'] ?? ''), true);
        $nonce = base64_decode((string) ($config['nonce'] ?? ''), true);
        if (!is_string($box) || !is_string($nonce) || strlen($nonce) !== SODIUM_CRYPTO_SECRETBOX_NONCEBYTES) {
            return '';
        }
        $value = sodium_crypto_secretbox_open($box, $nonce, self::encryption_key());
        return is_string($value) ? $value : '';
    }

    private static function request(string $url, array $args): array {
        $args += array('timeout' => 10, 'redirection' => 0, 'reject_unsafe_urls' => true, 'limit_response_size' => 65536);
        $response = wp_safe_remote_request($url, $args);
        if (is_wp_error($response)) {
            throw new RuntimeException('connection_failed');
        }
        $code = wp_remote_retrieve_response_code($response);
        $body = wp_remote_retrieve_body($response);
        if ($code < 200 || $code >= 300 || strlen($body) > 65536) {
            throw new RuntimeException('remote_rejected');
        }
        $decoded = json_decode($body, true, 8);
        if (!is_array($decoded)) {
            throw new RuntimeException('invalid_response');
        }
        return $decoded;
    }

    private static function save_status(string $category, bool $success = false): void {
        $current = get_option(self::STATUS, array());
        update_option(self::STATUS, array(
            'last_attempt' => gmdate('c'),
            'last_success' => $success ? gmdate('c') : (string) ($current['last_success'] ?? ''),
            'category' => substr($category, 0, 60),
        ), false);
    }

    public static function enroll(string $server, string $code, string $domain): void {
        if (is_multisite()) {
            throw new RuntimeException('multisite_unsupported');
        }
        $server = self::valid_server($server);
        $domain = self::normalize_domain($domain);
        $home_domain = self::normalize_domain((string) wp_parse_url(home_url('/'), PHP_URL_HOST));
        if (!$server || !$domain || !hash_equals($home_domain, $domain) || !preg_match('/^[A-Za-z0-9_-]{32}$/', $code)) {
            throw new RuntimeException('invalid_enrollment');
        }
        if (!function_exists('sodium_crypto_secretbox')) {
            throw new RuntimeException('sodium_unavailable');
        }
        $result = self::request($server . '/api/enrollment/exchange', array(
            'method' => 'POST',
            'headers' => array('Content-Type' => 'application/json'),
            'body' => wp_json_encode(array('code' => $code, 'domain' => $domain)),
        ));
        $installation = (string) ($result['installation_id'] ?? '');
        $credential = (string) ($result['credential'] ?? '');
        if (!preg_match('/^[0-9a-f-]{36}$/', $installation) || !preg_match('/^[A-Za-z0-9_-]{43}$/', $credential)) {
            throw new RuntimeException('invalid_exchange');
        }
        $secret = self::encrypt($credential);
        update_option(self::CONFIG, array(
            'server' => $server,
            'domain' => $domain,
            'installation_id' => $installation,
            'credential' => $secret['credential'],
            'nonce' => $secret['nonce'],
        ), false);
        delete_option(self::ENTITLEMENT);
        self::save_status('enrolled');
        self::poll(true);
    }

    public static function poll(bool $manual = false): bool {
        if (get_transient(self::LOCK)) {
            return false;
        }
        set_transient(self::LOCK, '1', 120);
        try {
            $config = get_option(self::CONFIG, array());
            $credential = is_array($config) ? self::credential($config) : '';
            if (!$credential || empty($config['server']) || empty($config['installation_id']) || empty($config['domain'])) {
                throw new RuntimeException('not_enrolled');
            }
            $keys = self::request($config['server'] . '/remote/v1/keys', array('method' => 'GET'));
            $entitlement = self::request($config['server'] . '/remote/v1/entitlement', array(
                'method' => 'POST',
                'headers' => array(
                    'Authorization' => 'Bearer ' . $credential,
                    'X-Installation-Id' => $config['installation_id'],
                ),
            ));
            $payload = $entitlement['payload'] ?? null;
            $signature = (string) ($entitlement['signature'] ?? '');
            if (!is_array($payload) || !HostPilot_Remote_Contract::validate($payload, $config['installation_id'], $config['domain'])) {
                throw new RuntimeException('invalid_contract');
            }
            $key_list = $keys['keys'] ?? null;
            if (!is_array($key_list)) {
                throw new RuntimeException('invalid_keys');
            }
            $public_key = '';
            foreach ($key_list as $key) {
                if (is_array($key) && isset($key['key_id'], $key['public_key']) && hash_equals((string) $payload['key_id'], (string) $key['key_id'])) {
                    $public_key = (string) $key['public_key'];
                    break;
                }
            }
            if (!$public_key || !HostPilot_Remote_Contract::verify($payload, $signature, $public_key)) {
                throw new RuntimeException('signature_failed');
            }
            update_option(self::ENTITLEMENT, $payload, false);
            self::save_status('verified', true);
            return true;
        } catch (Throwable $error) {
            self::save_status($error instanceof RuntimeException ? $error->getMessage() : 'internal_error');
            return false;
        } finally {
            delete_transient(self::LOCK);
        }
    }

    public static function admin_menu(): void {
        add_options_page('HostPilot Billing', 'HostPilot Billing', 'manage_options', 'hostpilot-remote', array(__CLASS__, 'settings_page'));
    }

    public static function settings_page(): void {
        if (!current_user_can('manage_options')) {
            return;
        }
        $message = '';
        if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
            check_admin_referer('hostpilot_remote');
            $action = sanitize_key(wp_unslash($_POST['hostpilot_action'] ?? ''));
            try {
                if ($action === 'enroll') {
                    self::enroll(
                        (string) wp_unslash($_POST['server'] ?? ''),
                        (string) wp_unslash($_POST['code'] ?? ''),
                        (string) wp_unslash($_POST['domain'] ?? '')
                    );
                    $message = 'Enrollment completed and the first signed check was attempted.';
                } elseif ($action === 'check') {
                    $message = self::poll(true) ? 'Signed entitlement verified.' : 'Check failed open. Review the status below.';
                } elseif ($action === 'disconnect') {
                    delete_option(self::CONFIG);
                    delete_option(self::ENTITLEMENT);
                    self::save_status('disconnected');
                    $message = 'Local credential removed. Revoke the installation in Billing as well.';
                }
            } catch (Throwable $error) {
                self::save_status($error instanceof RuntimeException ? $error->getMessage() : 'internal_error');
                $message = 'Enrollment failed open. Review the safe status below.';
            }
        }
        $config = get_option(self::CONFIG, array());
        $status = get_option(self::STATUS, array());
        $payload = get_option(self::ENTITLEMENT, array());
        ?>
        <div class="wrap"><h1>HostPilot Billing</h1>
        <?php if ($message) : ?><div class="notice notice-info"><p><?php echo esc_html($message); ?></p></div><?php endif; ?>
        <p>This plugin is fail-open. It verifies billing status but does not block the public website.</p>
        <?php if (empty($config['installation_id'])) : ?>
        <form method="post"><?php wp_nonce_field('hostpilot_remote'); ?><input type="hidden" name="hostpilot_action" value="enroll">
        <table class="form-table"><tr><th>Billing server</th><td><input class="regular-text" type="url" name="server" required placeholder="https://billing.example.com"></td></tr>
        <tr><th>Canonical domain</th><td><input class="regular-text" name="domain" required value="<?php echo esc_attr(self::normalize_domain((string) wp_parse_url(home_url('/'), PHP_URL_HOST))); ?>"></td></tr>
        <tr><th>One-time code</th><td><input class="regular-text" name="code" required autocomplete="off"></td></tr></table>
        <?php submit_button('Enroll site'); ?></form>
        <?php else : ?>
        <table class="widefat striped"><tbody>
        <tr><th>Domain</th><td><?php echo esc_html((string) $config['domain']); ?></td></tr>
        <tr><th>Installation</th><td><?php echo esc_html((string) $config['installation_id']); ?></td></tr>
        <tr><th>Last successful check</th><td><?php echo esc_html((string) ($status['last_success'] ?? 'Not yet')); ?></td></tr>
        <tr><th>Safe status</th><td><?php echo esc_html((string) ($status['category'] ?? 'Not checked')); ?></td></tr>
        <tr><th>Entitlement</th><td><?php echo esc_html((string) ($payload['entitlement_state'] ?? 'Unavailable')); ?></td></tr>
        </tbody></table>
        <form method="post" style="display:inline-block;margin-right:8px"><?php wp_nonce_field('hostpilot_remote'); ?><input type="hidden" name="hostpilot_action" value="check"><?php submit_button('Check billing now', 'primary', 'submit', false); ?></form>
        <form method="post" style="display:inline-block"><?php wp_nonce_field('hostpilot_remote'); ?><input type="hidden" name="hostpilot_action" value="disconnect"><button class="button" onclick="return confirm('Remove the local enrollment credential?')">Disconnect</button></form>
        <?php endif; ?></div>
        <?php
    }

    public static function site_health(array $info): array {
        $config = get_option(self::CONFIG, array());
        $status = get_option(self::STATUS, array());
        $payload = get_option(self::ENTITLEMENT, array());
        $info['hostpilot_remote'] = array(
            'label' => 'HostPilot Remote Billing',
            'fields' => array(
                'enrolled' => array('label' => 'Enrolled', 'value' => empty($config['installation_id']) ? 'No' : 'Yes'),
                'domain' => array('label' => 'Approved domain', 'value' => (string) ($config['domain'] ?? 'Not set')),
                'last_success' => array('label' => 'Last successful check', 'value' => (string) ($status['last_success'] ?? 'Not yet')),
                'status' => array('label' => 'Safe status', 'value' => (string) ($status['category'] ?? 'Not checked')),
                'contract' => array('label' => 'Contract version', 'value' => (string) ($payload['contract_version'] ?? 'Unavailable')),
                'state' => array('label' => 'Entitlement state', 'value' => (string) ($payload['entitlement_state'] ?? 'Unavailable')),
                'enforcement' => array('label' => 'Frontend enforcement', 'value' => 'Disabled (fail-open foundation)'),
            ),
        );
        return $info;
    }
}

register_activation_hook(__FILE__, array('HostPilot_Remote_Billing', 'activate'));
register_deactivation_hook(__FILE__, array('HostPilot_Remote_Billing', 'deactivate'));
HostPilot_Remote_Billing::init();
