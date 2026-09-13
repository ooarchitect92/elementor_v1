<?php
if (!defined('ABSPATH')) { exit; }

/**
 * Versioned facade over the bounded read-only inventory implementation.
 * Keeping the v4 capability contract separate avoids changing legacy discovery semantics.
 */
final class ForgeStudio_Connect_REST_V4 {
    public static function permissions() {
        return ForgeStudio_Connect_REST::permissions();
    }

    public static function register_routes(): void {
        foreach (array('health', 'capabilities', 'inventory') as $endpoint) {
            register_rest_route('forgestudio/v1', '/' . $endpoint, array(
                'methods' => 'GET',
                'callback' => array(__CLASS__, $endpoint),
                'permission_callback' => array(__CLASS__, 'permissions'),
            ));
        }
    }

    public static function health(): WP_REST_Response {
        return ForgeStudio_Connect_REST::health();
    }

    public static function inventory(): WP_REST_Response {
        return ForgeStudio_Connect_REST::inventory();
    }

    public static function capabilities(): WP_REST_Response {
        $write_enabled = current_user_can('forgestudio_connect_write');
        $response = new WP_REST_Response(array(
            'contract_version' => 1,
            'plugin_version' => '0.4.0',
            'mode' => $write_enabled ? 'guarded_read_write' : 'read_only',
            'capabilities' => array(
                'inspect' => true,
                'pairing' => true,
                'import' => true,
                'compatibility_passport' => true,
                'write_sync' => $write_enabled,
                'write_sync_preconditions' => $write_enabled,
                'write_sync_idempotency' => $write_enabled,
                'shortcode_execution' => false,
            ),
        ), 200);
        $response->header('Cache-Control', 'no-store');
        return $response;
    }
}
