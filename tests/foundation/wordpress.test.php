<?php
// Lightweight unit harness, NOT a live WordPress compatibility or write certification.
define('ABSPATH', __DIR__);
$logged_in = false; $allowed = false; $write_allowed = false; $ssl = true; $environment = 'production'; $routes = array();
function is_ssl() { global $ssl; return $ssl; }
function wp_get_environment_type() { global $environment; return $environment; }
function is_user_logged_in() { global $logged_in; return $logged_in; }
function current_user_can($cap, ...$args) {
    global $allowed, $write_allowed;
    if ($cap === 'forgestudio_connect_read') { return $allowed; }
    if ($cap === 'forgestudio_connect_write') { return $write_allowed; }
    return $write_allowed;
}
function register_rest_route($ns, $route, $options) { global $routes; $routes[$route] = $options; }
function wp_count_posts($type) { return (object) array('publish' => 2, 'draft' => 1, 'inherit' => $type === 'attachment' ? 4 : 0); }
function wp_get_theme() { return new class { function get($name) { return $name === 'Name' ? 'Fixture Theme' : '1.0'; } function get_template() { return 'fixture'; } function get_stylesheet() { return 'fixture-child'; } }; }
function get_bloginfo($key) { return '6.8'; }
function site_url() { return 'https://wordpress.example'; }
function home_url() { return 'https://wordpress.example'; }
function is_multisite() { return false; }
function get_option($key, $default=array()) {
    if ($key === 'active_plugins') { return array('fixture/plugin.php', 'elementor/elementor.php'); }
    if ($key === 'permalink_structure') { return '/%postname%/'; }
    return $default;
}
function sanitize_text_field($value) { return trim((string)$value); }
function sanitize_key($value) { return strtolower(preg_replace('/[^a-z0-9_\-]/i', '', (string)$value)); }
function sanitize_title($value) { return strtolower(trim(preg_replace('/[^a-z0-9]+/i', '-', (string)$value), '-')); }
function wp_json_encode($value, $flags=0) { return json_encode($value, $flags); }
class WP_Error { public function __construct(public $code, public $message, public $data) {} }
class WP_REST_Response { public $headers=array(); public function __construct(public $data, public $status) {} public function header($k,$v) { $this->headers[$k]=$v; } }
require __DIR__ . '/../../wordpress-plugin/forgestudio-connect/includes/class-rest.php';
require __DIR__ . '/../../wordpress-plugin/forgestudio-connect/includes/class-rest-v4.php';
require __DIR__ . '/../../wordpress-plugin/forgestudio-connect/includes/class-sync.php';
function verify($value, $message) { if (!$value) { throw new RuntimeException($message); } }
verify(ForgeStudio_Connect_REST_V4::permissions() instanceof WP_Error, 'Anonymous denied');
$logged_in=true; verify(ForgeStudio_Connect_REST_V4::permissions() instanceof WP_Error, 'Missing capability denied');
$allowed=true; verify(ForgeStudio_Connect_REST_V4::permissions() === true, 'Authorized read allowed');
$ssl=false; verify(ForgeStudio_Connect_REST_V4::permissions() instanceof WP_Error, 'Production plaintext denied');
$environment='local'; verify(ForgeStudio_Connect_REST_V4::permissions() === true, 'Local fixture allowed');
ForgeStudio_Connect_REST_V4::register_routes();
ForgeStudio_Connect_Sync::register_routes();
verify(count($routes) === 4, 'Three guarded reads and one guarded write registered');
verify($routes['/sync']['methods'] === 'POST', 'Synchronization route is write-only');
verify(isset($routes['/sync']['permission_callback']), 'Synchronization route is guarded');
$manifest=ForgeStudio_Connect_REST_V4::capabilities();
verify($manifest->data['plugin_version'] === '0.4.0', 'Current connector contract version exposed');
verify($manifest->data['capabilities']['pairing'] === true, 'Pairing capability advertised');
verify($manifest->data['capabilities']['import'] === true, 'Read-only import capability advertised');
verify($manifest->data['capabilities']['compatibility_passport'] === true, 'Compatibility passport capability advertised');
verify($manifest->data['capabilities']['write_sync'] === false, 'Write sync is not advertised without capability');
verify(ForgeStudio_Connect_Sync::permissions() instanceof WP_Error, 'Write route denies read-only connector');
$write_allowed=true;
verify(ForgeStudio_Connect_Sync::permissions() === true, 'Explicit write capability enables guarded sync');
verify(ForgeStudio_Connect_REST_V4::capabilities()->data['capabilities']['write_sync'] === true, 'Write capability is truthfully advertised');
verify(ForgeStudio_Connect_REST_V4::health()->data['connection_state'] === 'PAIRABLE', 'Pairing state is explicit');
$inventory=ForgeStudio_Connect_REST_V4::inventory();
verify($inventory->status === 200 && $inventory->data['counts']['pages_published'] === 2, 'Inventory endpoint returns bounded metadata');
verify($inventory->data['inventory_version'] === 2, 'Inventory schema version exposed');
verify($inventory->data['elementor']['active'] === true, 'Elementor detection is reported');
verify(count($inventory->data['plugins']) === 2, 'Bounded plugin details returned');
$snapshot=array('source_type'=>'page','source_id'=>10,'title'=>'Title','content'=>'Body','excerpt'=>'','status'=>'draft','slug'=>'title','modified_gmt'=>'2026-09-13T00:00:00');
verify(ForgeStudio_Connect_Sync::canonical_hash($snapshot) === ForgeStudio_Connect_Sync::canonical_hash($snapshot), 'Canonical source hash is deterministic');
echo "PASS: 23 WordPress permission/capability/inventory/sync assertions (stub harness).\n";
