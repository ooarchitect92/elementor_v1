<?php
// Lightweight unit harness, NOT a live WordPress compatibility certification.
define('ABSPATH', __DIR__);
$logged_in = false; $allowed = false; $ssl = true; $environment = 'production'; $routes = array();
function is_ssl() { global $ssl; return $ssl; }
function wp_get_environment_type() { global $environment; return $environment; }
function is_user_logged_in() { global $logged_in; return $logged_in; }
function current_user_can($cap) { global $allowed; return $allowed && $cap === 'forgestudio_connect_read'; }
function register_rest_route($ns, $route, $options) { global $routes; $routes[$route] = $options; }
function wp_count_posts($type) { return (object) array('publish' => 2, 'draft' => 1, 'inherit' => $type === 'attachment' ? 4 : 0); }
function wp_get_theme() { return new class { function get($name) { return $name === 'Name' ? 'Fixture Theme' : '1.0'; } function get_template() { return 'fixture'; } }; }
function get_bloginfo($key) { return '6.8'; }
function site_url() { return 'https://wordpress.example'; }
function home_url() { return 'https://wordpress.example'; }
function is_multisite() { return false; }
function get_option($key, $default=array()) { return $key === 'active_plugins' ? array('fixture/plugin.php') : $default; }
function sanitize_text_field($value) { return trim((string)$value); }
class WP_Error { public function __construct(public $code, public $message, public $data) {} }
class WP_REST_Response { public $headers=array(); public function __construct(public $data, public $status) {} public function header($k,$v) { $this->headers[$k]=$v; } }
require __DIR__ . '/../../wordpress-plugin/forgestudio-connect/includes/class-rest.php';
function verify($value, $message) { if (!$value) { throw new RuntimeException($message); } }
verify(ForgeStudio_Connect_REST::permissions() instanceof WP_Error, 'Anonymous denied');
$logged_in=true; verify(ForgeStudio_Connect_REST::permissions() instanceof WP_Error, 'Missing capability denied');
$allowed=true; verify(ForgeStudio_Connect_REST::permissions() === true, 'Authorized read allowed');
$ssl=false; verify(ForgeStudio_Connect_REST::permissions() instanceof WP_Error, 'Production plaintext denied');
$environment='local'; verify(ForgeStudio_Connect_REST::permissions() === true, 'Local fixture allowed');
ForgeStudio_Connect_REST::register_routes();
verify(count($routes) === 3, 'Only guarded read endpoints registered');
foreach ($routes as $route) { verify($route['methods'] === 'GET' && isset($route['permission_callback']), 'Guarded read route'); }
$manifest=ForgeStudio_Connect_REST::capabilities();
verify($manifest->data['capabilities']['pairing'] === true, 'Pairing capability advertised');
verify($manifest->data['capabilities']['import'] === true, 'Read-only import capability advertised');
verify($manifest->data['capabilities']['write_sync'] === false, 'No fake write capability');
verify(ForgeStudio_Connect_REST::health()->data['connection_state'] === 'PAIRABLE', 'Pairing state is explicit');
$inventory=ForgeStudio_Connect_REST::inventory();
verify($inventory->status === 200 && $inventory->data['counts']['pages_published'] === 2, 'Inventory endpoint returns bounded metadata');
echo "PASS: 13 WordPress permission/capability assertions (stub harness).\n";
