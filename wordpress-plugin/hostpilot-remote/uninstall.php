<?php

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

wp_clear_scheduled_hook('hostpilot_remote_poll');
delete_option('hostpilot_remote_config');
delete_option('hostpilot_remote_status');
delete_option('hostpilot_remote_entitlement');
delete_transient('hostpilot_remote_poll_lock');
