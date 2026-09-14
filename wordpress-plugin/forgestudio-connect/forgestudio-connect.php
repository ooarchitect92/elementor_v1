<?php
/**
 * Plugin Name: ForgeStudio Connect
 * Description: Secure read-only ForgeStudio pairing, capability discovery and source inventory. No WordPress write sync.
 * Version: 0.2.0
 * Requires at least: 6.0
 * Requires PHP: 8.1
 * License: GPL-2.0-or-later
 */
if (!defined('ABSPATH')) { exit; }
require_once __DIR__ . '/includes/class-rest.php';

function forgestudio_connect_activate(): void {
    add_role('forgestudio_connector', 'ForgeStudio Connector', array(
        'read' => true,
        'forgestudio_connect_read' => true,
    ));
    foreach (array('administrator', 'forgestudio_connector') as $name) {
        $role = get_role($name);
        if ($role) { $role->add_cap('forgestudio_connect_read'); }
    }
}

function forgestudio_connect_deactivate(): void {
    // Keep the role/capability so existing Application Password credentials fail predictably
    // only when explicitly revoked by the WordPress administrator.
}

register_activation_hook(__FILE__, 'forgestudio_connect_activate');
register_deactivation_hook(__FILE__, 'forgestudio_connect_deactivate');
add_action('rest_api_init', array('ForgeStudio_Connect_REST', 'register_routes'));
