import { createHash } from "node:crypto";

export type CompatibilityLevel = "SUPPORTED" | "PARTIAL" | "BLOCKED" | "UNKNOWN";
export type MigrationMode = "NATIVE_SYNC" | "HEADLESS" | "MANUAL_ASSIST" | "KEEP_WORDPRESS";

export interface WordPressInventory {
  coreVersion?: string;
  phpVersion?: string;
  theme?: { slug?: string; version?: string };
  plugins?: readonly { slug: string; version?: string; active?: boolean }[];
  gutenbergBlocks?: Readonly<Record<string, number>>;
  elementorWidgets?: Readonly<Record<string, number>>;
  shortcodes?: Readonly<Record<string, number>>;
  postTypes?: Readonly<Record<string, number>>;
  siteUrl?: string;
}

export interface CompatibilityFinding {
  type: "CORE" | "THEME" | "PLUGIN" | "GUTENBERG" | "ELEMENTOR" | "SHORTCODE" | "POST_TYPE";
  key: string;
  level: CompatibilityLevel;
  count: number;
  reason: string;
  action: string;
}

export interface CompatibilityPassport {
  schemaVersion: 1;
  inventoryHash: string;
  generatedAt: string;
  score: number;
  automationCoverage: number;
  migrationMode: MigrationMode;
  blockers: number;
  warnings: number;
  findings: readonly CompatibilityFinding[];
  summary: string;
}

const GUTENBERG: Readonly<Record<string, CompatibilityLevel>> = {
  "core/paragraph": "SUPPORTED", "core/heading": "SUPPORTED", "core/image": "SUPPORTED",
  "core/gallery": "SUPPORTED", "core/list": "SUPPORTED", "core/quote": "SUPPORTED",
  "core/buttons": "SUPPORTED", "core/button": "SUPPORTED", "core/group": "SUPPORTED",
  "core/columns": "SUPPORTED", "core/column": "SUPPORTED", "core/spacer": "SUPPORTED",
  "core/separator": "SUPPORTED", "core/video": "PARTIAL", "core/embed": "PARTIAL",
  "core/html": "PARTIAL", "core/shortcode": "PARTIAL", "core/navigation": "PARTIAL",
  "core/query": "PARTIAL", "core/post-template": "PARTIAL", "core/site-logo": "SUPPORTED",
};

const ELEMENTOR: Readonly<Record<string, CompatibilityLevel>> = {
  heading: "SUPPORTED", "text-editor": "SUPPORTED", image: "SUPPORTED", button: "SUPPORTED",
  divider: "SUPPORTED", spacer: "SUPPORTED", icon: "SUPPORTED", video: "PARTIAL",
  "google_maps": "PARTIAL", shortcode: "PARTIAL", html: "PARTIAL", form: "PARTIAL",
  posts: "PARTIAL", portfolio: "PARTIAL", "theme-site-logo": "SUPPORTED",
  "theme-site-title": "SUPPORTED", "theme-post-title": "SUPPORTED", "nav-menu": "PARTIAL",
  "woocommerce-products": "PARTIAL", "woocommerce-menu-cart": "PARTIAL",
};

const PLUGINS: Readonly<Record<string, CompatibilityLevel>> = {
  elementor: "SUPPORTED", "elementor-pro": "PARTIAL", woocommerce: "PARTIAL",
  "advanced-custom-fields": "PARTIAL", acf: "PARTIAL", yoast: "SUPPORTED",
  "wordpress-seo": "SUPPORTED", rankmath: "SUPPORTED", "seo-by-rank-math": "SUPPORTED",
  wpforms: "PARTIAL", "contact-form-7": "PARTIAL", gravityforms: "PARTIAL",
  learndash: "PARTIAL", lifterlms: "PARTIAL", polylang: "PARTIAL", wpml: "PARTIAL",
  wordfence: "SUPPORTED", "wp-super-cache": "SUPPORTED", "w3-total-cache": "SUPPORTED",
};

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function addMapFindings(
  findings: CompatibilityFinding[],
  type: CompatibilityFinding["type"],
  source: Readonly<Record<string, number>> | undefined,
  matrix: Readonly<Record<string, CompatibilityLevel>>,
): void {
  for (const [key, countValue] of Object.entries(source ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const count = Number.isSafeInteger(countValue) && countValue > 0 ? countValue : 0;
    if (count === 0) continue;
    const level = matrix[key] ?? "UNKNOWN";
    const reason = level === "SUPPORTED" ? "Mapped to a native ForgeStudio component."
      : level === "PARTIAL" ? "Content can be imported, but behavior or styling needs review."
      : level === "BLOCKED" ? "No safe automated conversion exists."
      : "This component is not in the certified compatibility matrix.";
    const action = level === "SUPPORTED" ? "Automate and verify visually."
      : level === "PARTIAL" ? "Import into a review queue and require approval."
      : level === "BLOCKED" ? "Keep on WordPress or rebuild manually."
      : "Run a sandbox conversion and classify before migration.";
    findings.push({ type, key, level, count, reason, action });
  }
}

function weightedCoverage(findings: readonly CompatibilityFinding[]): { score: number; blockers: number; warnings: number } {
  const weights: Readonly<Record<CompatibilityLevel, number>> = { SUPPORTED: 1, PARTIAL: 0.55, UNKNOWN: 0.15, BLOCKED: 0 };
  let total = 0;
  let supported = 0;
  let blockers = 0;
  let warnings = 0;
  for (const finding of findings) {
    const importance = Math.max(1, finding.count);
    total += importance;
    supported += importance * weights[finding.level];
    if (finding.level === "BLOCKED") blockers += finding.count;
    if (finding.level === "PARTIAL" || finding.level === "UNKNOWN") warnings += finding.count;
  }
  return { score: total === 0 ? 100 : Math.round(supported / total * 100), blockers, warnings };
}

export function buildCompatibilityPassport(inventory: WordPressInventory, generatedAt = new Date().toISOString()): CompatibilityPassport {
  if (!inventory || typeof inventory !== "object") throw new Error("INVALID_WORDPRESS_INVENTORY");
  const findings: CompatibilityFinding[] = [];
  const coreMajor = Number(String(inventory.coreVersion ?? "0").split(".")[0]);
  findings.push({
    type: "CORE", key: String(inventory.coreVersion ?? "unknown"),
    level: coreMajor >= 6 ? "SUPPORTED" : coreMajor >= 5 ? "PARTIAL" : "BLOCKED", count: 1,
    reason: coreMajor >= 6 ? "Supported WordPress REST and block APIs are available." : "Older WordPress versions require an upgrade before certified pairing.",
    action: coreMajor >= 6 ? "Continue with read-only discovery." : "Upgrade a staging clone and rerun the passport.",
  });
  if (inventory.theme?.slug) {
    findings.push({ type: "THEME", key: inventory.theme.slug, level: "PARTIAL", count: 1,
      reason: "Theme templates and runtime hooks cannot be assumed portable.", action: "Import tokens/content; visually rebuild theme templates in a staging workspace." });
  }
  for (const plugin of inventory.plugins ?? []) {
    if (plugin.active === false) continue;
    const level = PLUGINS[plugin.slug] ?? "UNKNOWN";
    findings.push({
      type: "PLUGIN", key: plugin.slug, level, count: 1,
      reason: level === "SUPPORTED" ? "The plugin does not block read-only migration or has a mapped data contract."
        : level === "PARTIAL" ? "Selected data can be mapped, but plugin runtime behavior remains in WordPress."
        : "No certified adapter is registered for this plugin.",
      action: level === "SUPPORTED" ? "Verify the exact installed version."
        : level === "PARTIAL" ? "Choose headless/keep-WordPress mode for unsupported runtime features."
        : "Create an adapter assessment before enabling writes.",
    });
  }
  addMapFindings(findings, "GUTENBERG", inventory.gutenbergBlocks, GUTENBERG);
  addMapFindings(findings, "ELEMENTOR", inventory.elementorWidgets, ELEMENTOR);
  addMapFindings(findings, "SHORTCODE", inventory.shortcodes, {});
  for (const [key, count] of Object.entries(inventory.postTypes ?? {})) {
    findings.push({ type: "POST_TYPE", key, level: ["post", "page", "attachment"].includes(key) ? "SUPPORTED" : "PARTIAL", count,
      reason: ["post", "page", "attachment"].includes(key) ? "Core content type." : "Custom type requires field/schema mapping.",
      action: ["post", "page", "attachment"].includes(key) ? "Import with revisions." : "Generate a custom-type mapping and validate required fields." });
  }
  const result = weightedCoverage(findings);
  const automationCoverage = Math.max(0, Math.min(100, result.score - (result.blockers > 0 ? 20 : 0)));
  const migrationMode: MigrationMode = result.blockers > 0 ? "KEEP_WORDPRESS"
    : automationCoverage >= 85 ? "NATIVE_SYNC"
    : automationCoverage >= 60 ? "HEADLESS"
    : "MANUAL_ASSIST";
  return {
    schemaVersion: 1,
    inventoryHash: hash(inventory),
    generatedAt,
    score: result.score,
    automationCoverage,
    migrationMode,
    blockers: result.blockers,
    warnings: result.warnings,
    findings,
    summary: `${automationCoverage}% estimated automation coverage; ${result.blockers} blockers and ${result.warnings} review items.`,
  };
}

export interface SyncVersion { sourceId: string; baseHash: string; remoteHash: string; desiredHash: string }
export type SyncDecision = "NOOP" | "APPLY" | "CONFLICT";

export function decideWordPressSync(version: SyncVersion): { decision: SyncDecision; reason: string } {
  for (const value of [version.baseHash, version.remoteHash, version.desiredHash]) if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("INVALID_SYNC_HASH");
  if (version.remoteHash === version.desiredHash) return { decision: "NOOP", reason: "Remote already matches the approved desired version." };
  if (version.remoteHash === version.baseHash) return { decision: "APPLY", reason: "Remote has not changed since the approved base snapshot." };
  if (version.desiredHash === version.baseHash) return { decision: "NOOP", reason: "ForgeStudio has no changes relative to the approved base snapshot." };
  return { decision: "CONFLICT", reason: "Both WordPress and ForgeStudio changed after the base snapshot; explicit resolution is required." };
}

export function contentFingerprint(value: unknown): string {
  return hash(value);
}
