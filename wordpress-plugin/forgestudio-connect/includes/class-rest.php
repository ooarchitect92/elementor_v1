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
        foreach (array('health', 'capabilities', 'inventory') as $endpoint) {
            register_rest_route('forgestudio/v1', '/' . $endpoint, array(
                'methods' => 'GET',
                'callback' => array(__CLASS__, $endpoint),
                'permission_callback' => array(__CLASS__, 'permissions'),
            ));
        }
    }

    public static function health(): WP_REST_Response {
        $response = new WP_REST_Response(array(
            'status' => 'available',
            'contract_version' => 1,
            'connection_state' => 'PAIRABLE',
        ), 200);
        $response->header('Cache-Control', 'no-store');
        return $response;
    }

    public static function capabilities(): WP_REST_Response {
        $response = new WP_REST_Response(array(
            'contract_version' => 1,
            'plugin_version' => '0.2.0',
            'mode' => 'read_only',
            'capabilities' => array(
                'inspect' => true,
                'pairing' => true,
                'import' => true,
                'write_sync' => false,
                'shortcode_execution' => false,
            ),
        ), 200);
        $response->header('Cache-Control', 'no-store');
        return $response;
    }

    public static function inventory(): WP_REST_Response {
        $page_counts = wp_count_posts('page');
        $post_counts = wp_count_posts('post');
        $media_counts = wp_count_posts('attachment');
        $theme = wp_get_theme();
        $plugins = get_option('active_plugins', array());
        if (!is_array($plugins)) { $plugins = array(); }

        $response = new WP_REST_Response(array(
            'contract_version' => 1,
            'wordpress_version' => get_bloginfo('version'),
            'site_url' => site_url(),
            'home_url' => home_url(),
            'multisite' => is_multisite(),
            'theme' => array(
                'name' => $theme->get('Name'),
                'version' => $theme->get('Version'),
                'template' => $theme->get_template(),
            ),
            'counts' => array(
                'pages_published' => intval($page_counts->publish ?? 0),
                'pages_draft' => intval($page_counts->draft ?? 0),
                'posts_published' => intval($post_counts->publish ?? 0),
                'posts_draft' => intval($post_counts->draft ?? 0),
                'media' => intval($media_counts->inherit ?? 0),
            ),
            'active_plugins' => array_values(array_map('sanitize_text_field', $plugins)),
        ), 200);
        $response->header('Cache-Control', 'no-store');
        return $response;
    }
}
