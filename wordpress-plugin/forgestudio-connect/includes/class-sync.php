<?php
if (!defined('ABSPATH')) { exit; }

final class ForgeStudio_Connect_Sync {
    private const RECEIPT_RETENTION_DAYS = 30;
    private const MAX_TEXT_BYTES = 2097152;

    public static function permissions() {
        if (!is_ssl() && wp_get_environment_type() !== 'local') {
            return new WP_Error('forgestudio_https_required', 'HTTPS is required.', array('status' => 403));
        }
        if (!is_user_logged_in() || !current_user_can('forgestudio_connect_write')) {
            return new WP_Error('forgestudio_write_forbidden', 'Connector write access is required.', array('status' => 403));
        }
        return true;
    }

    public static function register_routes(): void {
        register_rest_route('forgestudio/v1', '/sync', array(
            'methods' => 'POST',
            'callback' => array(__CLASS__, 'sync'),
            'permission_callback' => array(__CLASS__, 'permissions'),
        ));
    }

    private static function table_name(): string {
        global $wpdb;
        return $wpdb->prefix . 'forgestudio_sync_receipts';
    }

    public static function install_schema(): void {
        global $wpdb;
        $upgrade = ABSPATH . 'wp-admin/includes/upgrade.php';
        if (is_file($upgrade)) { require_once $upgrade; }
        if (!function_exists('dbDelta')) { return; }
        $charset = method_exists($wpdb, 'get_charset_collate') ? $wpdb->get_charset_collate() : '';
        $table = self::table_name();
        dbDelta("CREATE TABLE {$table} (
            id bigint unsigned NOT NULL AUTO_INCREMENT,
            idempotency_key varchar(191) NOT NULL,
            request_hash char(64) NOT NULL,
            source_type varchar(20) NOT NULL,
            source_id bigint unsigned NOT NULL,
            response_json longtext NOT NULL,
            created_at datetime NOT NULL,
            PRIMARY KEY  (id),
            UNIQUE KEY idempotency_key (idempotency_key),
            KEY source_lookup (source_type, source_id, created_at)
        ) {$charset};");
    }

    public static function canonical_hash(array $snapshot): string {
        $ordered = array(
            'source_type' => sanitize_key((string) ($snapshot['source_type'] ?? '')),
            'source_id' => intval($snapshot['source_id'] ?? 0),
            'title' => (string) ($snapshot['title'] ?? ''),
            'content' => (string) ($snapshot['content'] ?? ''),
            'excerpt' => (string) ($snapshot['excerpt'] ?? ''),
            'status' => sanitize_key((string) ($snapshot['status'] ?? '')),
            'slug' => sanitize_title((string) ($snapshot['slug'] ?? '')),
            'modified_gmt' => (string) ($snapshot['modified_gmt'] ?? ''),
        );
        return hash('sha256', wp_json_encode($ordered, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    private static function snapshot(WP_Post $post): array {
        return array(
            'source_type' => $post->post_type,
            'source_id' => intval($post->ID),
            'title' => (string) $post->post_title,
            'content' => (string) $post->post_content,
            'excerpt' => (string) $post->post_excerpt,
            'status' => (string) $post->post_status,
            'slug' => (string) $post->post_name,
            'modified_gmt' => (string) $post->post_modified_gmt,
        );
    }

    private static function request_hash(array $input): string {
        $desired = is_array($input['desired'] ?? null) ? $input['desired'] : array();
        $normalized = array(
            'source_type' => sanitize_key((string) ($input['source_type'] ?? '')),
            'source_id' => intval($input['source_id'] ?? 0),
            'expected_modified_gmt' => (string) ($input['expected_modified_gmt'] ?? ''),
            'expected_hash' => strtolower((string) ($input['expected_hash'] ?? '')),
            'desired' => array(
                'title' => (string) ($desired['title'] ?? ''),
                'content' => (string) ($desired['content'] ?? ''),
                'excerpt' => (string) ($desired['excerpt'] ?? ''),
                'status' => sanitize_key((string) ($desired['status'] ?? 'draft')),
                'slug' => sanitize_title((string) ($desired['slug'] ?? '')),
            ),
        );
        return hash('sha256', wp_json_encode($normalized, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    private static function response(array $body, int $status = 200): WP_REST_Response {
        $response = new WP_REST_Response($body, $status);
        $response->header('Cache-Control', 'no-store');
        return $response;
    }

    private static function validate_text(string $value, string $field): string {
        if (strlen($value) > self::MAX_TEXT_BYTES) {
            throw new InvalidArgumentException($field . '_too_large');
        }
        return $value;
    }

    public static function sync(WP_REST_Request $request) {
        global $wpdb;
        $input = $request->get_json_params();
        if (!is_array($input)) {
            return new WP_Error('forgestudio_sync_invalid', 'JSON request body is required.', array('status' => 400));
        }
        $idempotency_key = trim((string) ($input['idempotency_key'] ?? ''));
        if (!preg_match('/^[A-Za-z0-9:_-]{16,128}$/', $idempotency_key)) {
            return new WP_Error('forgestudio_sync_key_invalid', 'A valid idempotency key is required.', array('status' => 400));
        }
        $source_type = sanitize_key((string) ($input['source_type'] ?? ''));
        $source_id = intval($input['source_id'] ?? 0);
        $expected_modified = (string) ($input['expected_modified_gmt'] ?? '');
        $expected_hash = strtolower((string) ($input['expected_hash'] ?? ''));
        if (!in_array($source_type, array('page', 'post'), true) || $source_id < 1 || !preg_match('/^[0-9a-f]{64}$/', $expected_hash) || $expected_modified === '') {
            return new WP_Error('forgestudio_sync_invalid', 'Source identity and preconditions are required.', array('status' => 400));
        }
        if (!current_user_can('edit_post', $source_id)) {
            return new WP_Error('forgestudio_sync_forbidden', 'The connected user cannot edit this item.', array('status' => 403));
        }

        $request_hash = self::request_hash($input);
        $lock_name = 'fs_sync_' . substr(hash('sha256', $idempotency_key), 0, 48);
        $locked = intval($wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 5)', $lock_name))) === 1;
        if (!$locked) {
            return new WP_Error('forgestudio_sync_busy', 'Another synchronization is in progress.', array('status' => 409));
        }

        try {
            $table = self::table_name();
            $receipt = $wpdb->get_row($wpdb->prepare(
                "SELECT request_hash,response_json FROM {$table} WHERE idempotency_key=%s LIMIT 1",
                $idempotency_key
            ), ARRAY_A);
            if (is_array($receipt)) {
                if (!hash_equals((string) $receipt['request_hash'], $request_hash)) {
                    return new WP_Error('forgestudio_sync_key_reused', 'Idempotency key was used for a different change.', array('status' => 409));
                }
                $body = json_decode((string) $receipt['response_json'], true);
                if (!is_array($body)) { $body = array('success' => true); }
                $body['replayed'] = true;
                return self::response($body, 200);
            }

            $post = get_post($source_id);
            if (!($post instanceof WP_Post) || $post->post_type !== $source_type) {
                return new WP_Error('forgestudio_sync_source_missing', 'WordPress source item was not found.', array('status' => 404));
            }
            $current = self::snapshot($post);
            $current_hash = self::canonical_hash($current);
            if (!hash_equals($expected_hash, $current_hash) || $expected_modified !== $current['modified_gmt']) {
                return new WP_Error('forgestudio_sync_conflict', 'WordPress content changed since the imported snapshot.', array(
                    'status' => 409,
                    'current_hash' => $current_hash,
                    'current_modified_gmt' => $current['modified_gmt'],
                ));
            }

            $desired = is_array($input['desired'] ?? null) ? $input['desired'] : array();
            $status = sanitize_key((string) ($desired['status'] ?? $current['status']));
            if (!in_array($status, array('draft', 'pending', 'private', 'publish'), true)) {
                return new WP_Error('forgestudio_sync_status_invalid', 'Unsupported WordPress status.', array('status' => 400));
            }
            if ($status === 'publish') {
                $publish_cap = $source_type === 'page' ? 'publish_pages' : 'publish_posts';
                if (!current_user_can($publish_cap)) {
                    return new WP_Error('forgestudio_sync_publish_forbidden', 'The connected user cannot publish this item.', array('status' => 403));
                }
            }

            try {
                $title = self::validate_text((string) ($desired['title'] ?? $current['title']), 'title');
                $content = self::validate_text((string) ($desired['content'] ?? $current['content']), 'content');
                $excerpt = self::validate_text((string) ($desired['excerpt'] ?? $current['excerpt']), 'excerpt');
            } catch (InvalidArgumentException $error) {
                return new WP_Error('forgestudio_sync_too_large', $error->getMessage(), array('status' => 413));
            }

            $updated_id = wp_update_post(array(
                'ID' => $source_id,
                'post_title' => wp_slash($title),
                'post_content' => wp_slash($content),
                'post_excerpt' => wp_slash($excerpt),
                'post_status' => $status,
                'post_name' => sanitize_title((string) ($desired['slug'] ?? $current['slug'])),
            ), true);
            if (is_wp_error($updated_id)) {
                return new WP_Error('forgestudio_sync_update_failed', $updated_id->get_error_message(), array('status' => 500));
            }

            clean_post_cache($source_id);
            $updated = get_post($source_id);
            if (!($updated instanceof WP_Post)) {
                return new WP_Error('forgestudio_sync_update_unverified', 'Updated item could not be verified.', array('status' => 500));
            }
            $snapshot = self::snapshot($updated);
            $body = array(
                'success' => true,
                'replayed' => false,
                'source_type' => $source_type,
                'source_id' => $source_id,
                'modified_gmt' => $snapshot['modified_gmt'],
                'source_hash' => self::canonical_hash($snapshot),
                'status' => $snapshot['status'],
            );
            $stored = $wpdb->insert($table, array(
                'idempotency_key' => $idempotency_key,
                'request_hash' => $request_hash,
                'source_type' => $source_type,
                'source_id' => $source_id,
                'response_json' => wp_json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
                'created_at' => current_time('mysql', true),
            ), array('%s','%s','%s','%d','%s','%s'));
            if ($stored !== 1) {
                return new WP_Error('forgestudio_sync_receipt_failed', 'The content changed but its synchronization receipt was not saved.', array('status' => 500));
            }
            $wpdb->query($wpdb->prepare(
                "DELETE FROM {$table} WHERE created_at < %s",
                gmdate('Y-m-d H:i:s', time() - DAY_IN_SECONDS * self::RECEIPT_RETENTION_DAYS)
            ));
            return self::response($body, 200);
        } finally {
            $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock_name));
        }
    }
}
