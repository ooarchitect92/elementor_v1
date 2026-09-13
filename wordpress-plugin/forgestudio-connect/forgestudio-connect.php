<?php
/**
 * Plugin Name: ForgeStudio Connect
 * Description: Secure ForgeStudio pairing, read-only inventory/import and conflict-safe WordPress synchronization.
 * Version: 0.4.0
 * Requires at least: 6.0
 * Requires PHP: 8.1
 * License: GPL-2.0-or-later
 */
if (!defined('ABSPATH')) { exit; }
require_once __DIR__ . '/includes/class-rest.php';
require_once __DIR__ . '/includes/class-rest-v4.php';
require_once __DIR__ . '/includes/class-sync.php';

function forgestudio_connect_activate(): void {
    add_role('forgestudio_connector', 'ForgeStudio Connector', array(
        'read' => true,
        'forgestudio_connect_read' => true,
    ));
    foreach (array('administrator', 'forgestudio_connector') as $name) {
        $role = get_role($name);
        if ($role) { $role->add_cap('forgestudio_connect_read'); }
    }
    // Source writes are intentionally limited to administrators unless a WordPress owner
    // explicitly grants the separate capability to a dedicated connector role.
    $administrator = get_role('administrator');
    if ($administrator) { $administrator->add_cap('forgestudio_connect_write'); }
    ForgeStudio_Connect_Sync::install_schema();
}

function forgestudio_connect_deactivate(): void {
    // Keep capabilities and receipts so credentials and prior writes remain auditable/revocable.
}

register_activation_hook(__FILE__, 'forgestudio_connect_activate');
register_deactivation_hook(__FILE__, 'forgestudio_connect_deactivate');
add_action('rest_api_init', array('ForgeStudio_Connect_REST_V4', 'register_routes'));
add_action('rest_api_init', array('ForgeStudio_Connect_Sync', 'register_routes'));
