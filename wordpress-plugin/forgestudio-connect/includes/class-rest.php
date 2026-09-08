<?php
if (!defined('ABSPATH')) { exit; }
final class ForgeStudio_Connect_REST {
    public static function permissions() {
        if (!is_ssl() && wp_get_environment_type() !== 'local') {
            return new WP_Error('forgestudio_https_required', 'HTTPS is required.', array('status' => 403));
        }
        if (!is_user_logged_in() || !current_user_can('forgestudio_connect_read')) {
            return new WP_Error('forgestudio_forbidden', 'Connector access is required.', array('status' => 403));
        }
        return true;
    }
    public static function register_routes(): void {
        foreach (array('health', 'capabilities') as $endpoint) {
            register_rest_route('forgestudio/v1', '/' . $endpoint, array(
                'methods' => 'GET', 'callback' => array(__CLASS__, $endpoint),
                'permission_callback' => array(__CLASS__, 'permissions'),
            ));
        }
    }
    public static function health(): WP_REST_Response {
        $response = new WP_REST_Response(array('status' => 'available', 'contract_version' => 1, 'connection_state' => 'UNPAIRED'), 200);
        $response->header('Cache-Control', 'no-store');
        return $response;
    }
    public static function capabilities(): WP_REST_Response {
        $response = new WP_REST_Response(array(
            'contract_version' => 1, 'plugin_version' => '0.1.0', 'mode' => 'read_only',
            'capabilities' => array('inspect' => true, 'pairing' => false, 'import' => false, 'write_sync' => false, 'shortcode_execution' => false),
        ), 200);
        $response->header('Cache-Control', 'no-store');
        return $response;
    }
}
