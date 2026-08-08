<?php

if (!defined('ABSPATH') && PHP_SAPI !== 'cli') {
    exit;
}

final class HostPilot_Remote_Contract {
    private const FIELDS = array(
        'contract_version', 'installation_id', 'approved_canonical_domain',
        'entitlement_state', 'issued_at', 'expires_at', 'renewal_url',
        'amount_minor', 'currency', 'renewal_months', 'enforcement_enabled', 'key_id',
    );

    public static function canonicalize(array $payload): string {
        ksort($payload, SORT_STRING);
        return (string) wp_json_encode($payload, JSON_UNESCAPED_SLASHES);
    }

    private static function base64url_decode(string $value): string {
        if (!preg_match('/^[A-Za-z0-9_-]+$/', $value)) {
            return '';
        }
        $padding = (4 - strlen($value) % 4) % 4;
        $decoded = base64_decode(strtr($value, '-_', '+/') . str_repeat('=', $padding), true);
        return is_string($decoded) ? $decoded : '';
    }

    private static function public_key_bytes(string $pem): string {
        $body = preg_replace('/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s+/', '', $pem);
        $der = base64_decode((string) $body, true);
        $prefix = hex2bin('302a300506032b6570032100');
        if (!is_string($der) || strlen($der) !== 44 || substr($der, 0, 12) !== $prefix) {
            return '';
        }
        return substr($der, 12);
    }

    public static function verify(array $payload, string $signature, string $public_key): bool {
        if (!function_exists('sodium_crypto_sign_verify_detached')) {
            return false;
        }
        $signature_bytes = self::base64url_decode($signature);
        $public_bytes = self::public_key_bytes($public_key);
        return strlen($signature_bytes) === SODIUM_CRYPTO_SIGN_BYTES
            && strlen($public_bytes) === SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES
            && sodium_crypto_sign_verify_detached($signature_bytes, self::canonicalize($payload), $public_bytes);
    }

    public static function validate(array $payload, string $installation_id, string $domain, ?int $now = null): bool {
        $keys = array_keys($payload);
        sort($keys, SORT_STRING);
        $expected = self::FIELDS;
        sort($expected, SORT_STRING);
        if ($keys !== $expected || $payload['contract_version'] !== 1) {
            return false;
        }
        if (!is_string($payload['installation_id']) || !hash_equals($installation_id, $payload['installation_id'])) {
            return false;
        }
        if (!is_string($payload['approved_canonical_domain']) || !hash_equals($domain, strtolower($payload['approved_canonical_domain']))) {
            return false;
        }
        if (!in_array($payload['entitlement_state'], array('active', 'reminder', 'grace', 'suspended', 'exempt'), true)) {
            return false;
        }
        if (!is_bool($payload['enforcement_enabled']) || !is_int($payload['amount_minor'])
            || $payload['amount_minor'] < 0 || !is_int($payload['renewal_months'])
            || $payload['renewal_months'] < 1 || $payload['renewal_months'] > 120) {
            return false;
        }
        if (!is_string($payload['currency']) || !preg_match('/^[A-Z]{3}$/', $payload['currency'])
            || !is_string($payload['key_id']) || strlen($payload['key_id']) > 80) {
            return false;
        }
        if (!is_string($payload['renewal_url'])) {
            return false;
        }
        if ($payload['renewal_url'] !== '') {
            $renewal = parse_url($payload['renewal_url']);
            if (!is_array($renewal) || strtolower((string) ($renewal['scheme'] ?? '')) !== 'https'
                || empty($renewal['host']) || isset($renewal['user']) || isset($renewal['pass'])
                || isset($renewal['fragment'])) {
                return false;
            }
        }
        $issued = is_string($payload['issued_at']) ? strtotime($payload['issued_at']) : false;
        $expires = is_string($payload['expires_at']) ? strtotime($payload['expires_at']) : false;
        $clock = $now ?? time();
        return $issued !== false && $expires !== false && $issued <= $clock + 300
            && $expires > $clock && $expires > $issued && ($expires - $issued) <= 600;
    }
}
