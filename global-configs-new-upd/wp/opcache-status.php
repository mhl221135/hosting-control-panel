<?php

declare(strict_types=1);

header('Content-Type: application/json');

$status = opcache_get_status(false);
if ($status === false) {
    echo json_encode(['enabled' => false], JSON_THROW_ON_ERROR);
    return;
}

$memory = $status['memory_usage'] ?? [];
$strings = $status['interned_strings_usage'] ?? [];
$statistics = $status['opcache_statistics'] ?? [];

echo json_encode([
    'enabled' => true,
    'cacheFull' => (bool) ($status['cache_full'] ?? false),
    'restartPending' => (bool) ($status['restart_pending'] ?? false),
    'restartInProgress' => (bool) ($status['restart_in_progress'] ?? false),
    'memory' => [
        'usedBytes' => (int) ($memory['used_memory'] ?? 0),
        'freeBytes' => (int) ($memory['free_memory'] ?? 0),
        'wastedBytes' => (int) ($memory['wasted_memory'] ?? 0),
        'wastedPercent' => (float) ($memory['current_wasted_percentage'] ?? 0),
    ],
    'internedStrings' => [
        'usedBytes' => (int) ($strings['used_memory'] ?? 0),
        'freeBytes' => (int) ($strings['free_memory'] ?? 0),
        'strings' => (int) ($strings['number_of_strings'] ?? 0),
    ],
    'statistics' => [
        'cachedScripts' => (int) ($statistics['num_cached_scripts'] ?? 0),
        'cachedKeys' => (int) ($statistics['num_cached_keys'] ?? 0),
        'maxCachedKeys' => (int) ($statistics['max_cached_keys'] ?? 0),
        'hits' => (int) ($statistics['hits'] ?? 0),
        'misses' => (int) ($statistics['misses'] ?? 0),
        'hitRate' => (float) ($statistics['opcache_hit_rate'] ?? 0),
        'oomRestarts' => (int) ($statistics['oom_restarts'] ?? 0),
        'hashRestarts' => (int) ($statistics['hash_restarts'] ?? 0),
        'manualRestarts' => (int) ($statistics['manual_restarts'] ?? 0),
    ],
], JSON_THROW_ON_ERROR);
