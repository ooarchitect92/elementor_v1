<?php
if (!defined('ABSPATH')) { exit; }

final class ForgeStudio_Connect_REST {
    private const MAX_DISCOVERY_POSTS = 500;
    private const MAX_BLOCK_TYPES = 1000;

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
            'plugin_version' => '0.3.0',
            'mode' => 'read_only',
            'capabilities' => array(
                'inspect' => true,
                'pairing' => true,
                'import' => true,
                'compatibility_passport' => true,
                'write_sync' => false,
                'shortcode_execution' => false,
            ),
        ), 200);
        $response->header('Cache-Control', 'no-store');
        return $response;
    }

    private static function plugin_details(array $plugin_files): array {
        $include = ABSPATH . 'wp-admin/includes/plugin.php';
        if (!function_exists('get_plugin_data') && is_file($include)) { require_once $include; }
        $details = array();
        foreach (array_slice(array_values($plugin_files), 0, 500) as $file) {
            $safe_file = sanitize_text_field((string) $file);
            $row = array('file' => $safe_file, 'name' => $safe_file, 'version' => '');
            $full_path = defined('WP_PLUGIN_DIR') ? WP_PLUGIN_DIR . '/' . $safe_file : '';
            if ($full_path && function_exists('get_plugin_data') && is_file($full_path)) {
                $data = get_plugin_data($full_path, false, false);
                $row['name'] = sanitize_text_field((string) ($data['Name'] ?? $safe_file));
                $row['version'] = sanitize_text_field((string) ($data['Version'] ?? ''));
            }
            $details[] = $row;
        }
        return $details;
    }

    private static function count_blocks(array $blocks, array &$usage): void {
        foreach ($blocks as $block) {
            if (!is_array($block)) { continue; }
            $name = sanitize_text_field((string) ($block['blockName'] ?? ''));
            if ($name !== '' && preg_match('/^[a-z0-9-]+\/[a-z0-9-]+$/i', $name)) {
                $usage[$name] = intval($usage[$name] ?? 0) + 1;
            }
            if (!empty($block['innerBlocks']) && is_array($block['innerBlocks'])) {
                self::count_blocks($block['innerBlocks'], $usage);
            }
        }
    }

    private static function block_usage(): array {
        if (!function_exists('parse_blocks') || !class_exists('WP_Query') || !function_exists('get_post_field')) { return array(); }
        $query = new WP_Query(array(
            'post_type' => array('page', 'post'),
            'post_status' => array('publish', 'draft', 'private', 'pending'),
            'posts_per_page' => self::MAX_DISCOVERY_POSTS,
            'fields' => 'ids',
            'orderby' => 'ID',
            'order' => 'ASC',
            'no_found_rows' => true,
            'suppress_filters' => true,
        ));
        $usage = array();
        foreach (array_slice((array) $query->posts, 0, self::MAX_DISCOVERY_POSTS) as $post_id) {
            $content = (string) get_post_field('post_content', intval($post_id));
            if ($content !== '') { self::count_blocks((array) parse_blocks($content), $usage); }
            if (count($usage) >= self::MAX_BLOCK_TYPES) { break; }
        }
        ksort($usage);
        return array_slice($usage, 0, self::MAX_BLOCK_TYPES, true);
    }

    private static function registered_blocks(): array {
        if (!class_exists('WP_Block_Type_Registry')) { return array(); }
        $registry = WP_Block_Type_Registry::get_instance();
        if (!$registry || !method_exists($registry, 'get_all_registered')) { return array(); }
        $names = array_keys((array) $registry->get_all_registered());
        $names = array_values(array_filter(array_map('sanitize_text_field', $names)));
        sort($names);
        return array_slice($names, 0, self::MAX_BLOCK_TYPES);
    }

    private static function elementor_inventory(array $plugins): array {
        global $wpdb;
        $active = defined('ELEMENTOR_VERSION') || count(array_filter($plugins, static fn($file) => preg_match('/(^|\/)elementor(-pro)?\//i', (string) $file))) > 0;
        $documents = 0;
        if ($active && isset($wpdb) && isset($wpdb->postmeta) && method_exists($wpdb, 'get_var') && method_exists($wpdb, 'prepare')) {
            $documents = intval($wpdb->get_var($wpdb->prepare(
                "SELECT COUNT(DISTINCT post_id) FROM {$wpdb->postmeta} WHERE meta_key=%s AND meta_value=%s",
                '_elementor_edit_mode',
                'builder'
            )));
        }
        return array(
            'active' => $active,
            'version' => defined('ELEMENTOR_VERSION') ? sanitize_text_field((string) ELEMENTOR_VERSION) : '',
            'documents' => $documents,
            'exact_widget_conversion' => false,
        );
    }

    private static function woocommerce_inventory(array $plugins): array {
        $active = defined('WC_VERSION') || count(array_filter($plugins, static fn($file) => stripos((string) $file, 'woocommerce') !== false)) > 0;
        return array(
            'active' => $active,
            'version' => defined('WC_VERSION') ? sanitize_text_field((string) WC_VERSION) : '',
            'commerce_runtime_retained' => $active,
        );
    }

    public static function inventory(): WP_REST_Response {
        $page_counts = wp_count_posts('page');
        $post_counts = wp_count_posts('post');
        $media_counts = wp_count_posts('attachment');
        $theme = wp_get_theme();
        $plugins = get_option('active_plugins', array());
        if (!is_array($plugins)) { $plugins = array(); }
        $plugins = array_values(array_map('sanitize_text_field', array_slice($plugins, 0, 500)));
        $stylesheet = method_exists($theme, 'get_stylesheet') ? sanitize_text_field((string) $theme->get_stylesheet()) : '';
        $post_types = function_exists('get_post_types')
            ? array_values(array_slice(array_map('sanitize_text_field', get_post_types(array('public' => true), 'names')), 0, 500))
            : array('post', 'page');

        $response = new WP_REST_Response(array(
            'contract_version' => 1,
            'inventory_version' => 2,
            'bounded' => true,
            'discovery_post_limit' => self::MAX_DISCOVERY_POSTS,
            'wordpress_version' => get_bloginfo('version'),
            'php_version' => PHP_VERSION,
            'site_url' => site_url(),
            'home_url' => home_url(),
            'multisite' => is_multisite(),
            'permalink_structure' => sanitize_text_field((string) get_option('permalink_structure', '')),
            'theme' => array(
                'name' => sanitize_text_field((string) $theme->get('Name')),
                'version' => sanitize_text_field((string) $theme->get('Version')),
                'template' => sanitize_text_field((string) $theme->get_template()),
                'stylesheet' => $stylesheet,
            ),
            'counts' => array(
                'pages_published' => intval($page_counts->publish ?? 0),
                'pages_draft' => intval($page_counts->draft ?? 0),
                'posts_published' => intval($post_counts->publish ?? 0),
                'posts_draft' => intval($post_counts->draft ?? 0),
                'media' => intval($media_counts->inherit ?? 0),
            ),
            'public_post_types' => $post_types,
            'active_plugins' => $plugins,
            'plugins' => self::plugin_details($plugins),
            'registered_blocks' => self::registered_blocks(),
            'block_usage' => self::block_usage(),
            'elementor' => self::elementor_inventory($plugins),
            'woocommerce' => self::woocommerce_inventory($plugins),
        ), 200);
        $response->header('Cache-Control', 'no-store');
        return $response;
    }
}
