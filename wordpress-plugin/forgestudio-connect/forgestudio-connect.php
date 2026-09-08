<?php
/**
 * Plugin Name: ForgeStudio Connect
 * Description: Read-only capability discovery foundation. Pairing and write sync are not enabled.
 * Version: 0.1.0
 * Requires at least: 6.0
 * Requires PHP: 8.1
 * License: GPL-2.0-or-later
 */
if (!defined('ABSPATH')) { exit; }
require_once __DIR__ . '/includes/class-rest.php';
function forgestudio_connect_activate(): void {
    add_role('forgestudio_connector', 'ForgeStudio Connector', array('read' => true, 'forgestudio_connect_read' => true));
    foreach (array('administrator', 'forgestudio_connector') as $name) {
        $role = get_role($name);
        if ($role) { $role->add_cap('forgestudio_connect_read'); }
    }
}
register_activation_hook(__FILE__, 'forgestudio_connect_activate');
add_action('rest_api_init', array('ForgeStudio_Connect_REST', 'register_routes'));
