<?php

define('ABSPATH', __DIR__);
function wp_json_encode($value, $flags = 0) { return json_encode($value, $flags); }
require_once __DIR__ . '/../hostpilot-remote/includes/class-hostpilot-contract.php';

function expect_true($value, $message) {
    if (!$value) {
        fwrite(STDERR, $message . "\n");
        exit(1);
    }
}

$keypair = sodium_crypto_sign_keypair();
$public = sodium_crypto_sign_publickey($keypair);
$private = sodium_crypto_sign_secretkey($keypair);
$pem = "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode(hex2bin('302a300506032b6570032100') . $public), 64, "\n") . "-----END PUBLIC KEY-----\n";
$now = time();
$payload = array(
    'contract_version' => 1,
    'installation_id' => '11111111-1111-4111-8111-111111111111',
    'approved_canonical_domain' => 'remote.test.example',
    'entitlement_state' => 'active',
    'issued_at' => gmdate('c', $now),
    'expires_at' => gmdate('c', $now + 300),
    'renewal_url' => 'https://billing.test.example/renew/r1_test',
    'amount_minor' => 8000,
    'currency' => 'USD',
    'renewal_months' => 12,
    'enforcement_enabled' => false,
    'key_id' => '22222222-2222-4222-8222-222222222222',
);
$canonical = HostPilot_Remote_Contract::canonicalize($payload);
$signature = rtrim(strtr(base64_encode(sodium_crypto_sign_detached($canonical, $private)), '+/', '-_'), '=');
expect_true(HostPilot_Remote_Contract::validate($payload, $payload['installation_id'], $payload['approved_canonical_domain'], $now), 'valid contract rejected');
expect_true(HostPilot_Remote_Contract::verify($payload, $signature, $pem), 'valid signature rejected');
$invalid = $payload;
$invalid['amount_minor'] = -1;
expect_true(!HostPilot_Remote_Contract::validate($invalid, $invalid['installation_id'], $invalid['approved_canonical_domain'], $now), 'invalid amount accepted');
$invalid = $payload;
$invalid['expires_at'] = gmdate('c', $now - 1);
expect_true(!HostPilot_Remote_Contract::validate($invalid, $invalid['installation_id'], $invalid['approved_canonical_domain'], $now), 'expired contract accepted');
expect_true(!HostPilot_Remote_Contract::validate($payload, $payload['installation_id'], 'clone.test.example', $now), 'domain mismatch accepted');
$invalid = $payload;
$invalid['unexpected'] = true;
expect_true(!HostPilot_Remote_Contract::validate($invalid, $invalid['installation_id'], $invalid['approved_canonical_domain'], $now), 'unknown field accepted');
$invalid = $payload;
$invalid['renewal_url'] = 'https://user:password@billing.test.example/renew#secret';
expect_true(!HostPilot_Remote_Contract::validate($invalid, $invalid['installation_id'], $invalid['approved_canonical_domain'], $now), 'unsafe renewal URL accepted');
$tampered = $payload;
$tampered['amount_minor'] = 1;
expect_true(!HostPilot_Remote_Contract::verify($tampered, $signature, $pem), 'tampered signature accepted');
echo "HostPilot contract tests passed\n";
