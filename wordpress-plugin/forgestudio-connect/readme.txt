=== ForgeStudio Connect ===
Contributors: ooarchitect92
Requires at least: 6.0
Requires PHP: 8.1
Stable tag: 0.1.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Read-only capability discovery foundation. No content is imported or overwritten.

== Installation ==
Install/activate in a disposable WordPress site first. Use HTTPS outside the local Docker fixture.
Create a dedicated WordPress user with the ForgeStudio Connector role. Use a revocable WordPress
Application Password, not the administrator password. Application Passwords inherit user capabilities;
they are not OAuth scopes. No credentials are created, stored or sent by this plugin.
GET /wp-json/forgestudio/v1/health and /capabilities require the custom capability.
No public route, arbitrary PHP/SQL executor, sync/apply endpoint or plugin installer is exposed.

== Current scope ==
Pairing, remote credential vaulting, WordPress.com OAuth, import, write synchronization and compatibility
certification remain F09/P01 tasks. UNPAIRED is deliberate. Deactivation removes access to these routes
but does not revoke the WordPress Application Password; revoke it from the user's WordPress profile.
The Docker local environment is HTTP-only and must never be promoted as a production configuration.
This plugin makes no external network requests and collects no telemetry.
