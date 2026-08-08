<?php
/**
 * Plugin Name: HostPilot Remote Billing Loader
 * Description: Loads the managed HostPilot Remote Billing plugin before ordinary plugins.
 * Version: 0.1.0
 */

$hostpilot_plugin = WP_PLUGIN_DIR . '/hostpilot-remote/hostpilot-remote.php';
if (is_readable($hostpilot_plugin) && !class_exists('HostPilot_Remote_Billing')) {
    require_once $hostpilot_plugin;
}
