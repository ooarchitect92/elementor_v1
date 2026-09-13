export type CompatibilityLevel = "NATIVE" | "PARTIAL" | "MANUAL" | "UNSUPPORTED";
export type CompatibilitySeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface WordPressSourceRecord {
  sourceType: "page" | "post" | "media" | "term";
  sourceId: string;
  payload: unknown;
}

export interface WordPressInventory {
  wordpress_version?: string;
  php_version?: string;
  multisite?: boolean;
  theme?: { name?: string; version?: string; template?: string; stylesheet?: string };
  active_plugins?: string[];
  plugins?: Array<{ file?: string; name?: string; version?: string }>;
  block_usage?: Record<string, number>;
  elementor?: { active?: boolean; version?: string; documents?: number };
  woocommerce?: { active?: boolean; version?: string };
  counts?: Record<string, number>;
}

export interface CompatibilityFinding {
  code: string;
  severity: CompatibilitySeverity;
  category: "CORE" | "BLOCK" | "BUILDER" | "PLUGIN" | "THEME" | "CONTENT" | "OPERATIONS";
  level: CompatibilityLevel;
  title: string;
  detail: string;
  recommendation: string;
  count: number;
  samples: string[];
}

export interface CompatibilityPassport {
  score: number;
  grade: "A" | "B" | "C" | "D" | "E";
  migrationMode: "DIRECT" | "ASSISTED" | "HEADLESS_RETAIN" | "REBUILD_RECOMMENDED";
  summary: {
    sourceItems: number;
    discoveredBlocks: number;
    activePlugins: number;
    native: number;
    partial: number;
    manual: number;
    unsupported: number;
    elementorDetected: boolean;
    woocommerceDetected: boolean;
    multisite: boolean;
  };
  findings: CompatibilityFinding[];
}

const NATIVE_BLOCKS = new Set([
  "core/paragraph", "core/heading", "core/image", "core/gallery", "core/list", "core/list-item",
  "core/quote", "core/pullquote", "core/buttons", "core/button", "core/columns", "core/column",
  "core/group", "core/row", "core/stack", "core/cover", "core/media-text", "core/spacer",
  "core/separator", "core/video", "core/audio", "core/file", "core/table", "core/embed",
  "core/social-links", "core/social-link", "core/code", "core/preformatted", "core/verse",
]);
const PARTIAL_BLOCKS = new Set([
  "core/navigation", "core/query", "core/post-template", "core/template-part", "core/site-logo",
  "core/site-title", "core/post-title", "core/post-content", "core/post-excerpt", "core/post-featured-image",
  "core/latest-posts", "core/latest-comments", "core/search", "core/comments", "core/loginout",
  "core/shortcode", "core/html", "core/rss", "core/calendar", "core/archives", "core/categories",
]);

const PLUGIN_RULES: Array<{
  match: RegExp;
  code: string;
  title: string;
  level: CompatibilityLevel;
  severity: CompatibilitySeverity;
  detail: string;
  recommendation: string;
}> = [
  {
    match: /(^|\/)elementor(-pro)?\//i,
    code: "ELEMENTOR_LAYOUTS_DETECTED",
    title: "Elementor documents require assisted conversion",
    level: "PARTIAL",
    severity: "MEDIUM",
    detail: "ForgeStudio can inventory Elementor usage, but arbitrary third-party Elementor widgets and theme-builder conditions are not losslessly portable.",
    recommendation: "Run document-level previews and rebuild unsupported widgets before changing production ownership.",
  },
  {
    match: /advanced-custom-fields|acf-pro/i,
    code: "ACF_SCHEMA_MAPPING_REQUIRED",
    title: "ACF field groups require schema mapping",
    level: "PARTIAL",
    severity: "MEDIUM",
    detail: "Structured ACF values can be imported, but field groups, repeaters, relationships and PHP display logic require explicit mappings.",
    recommendation: "Create a field-by-field mapping and verify relationship/repeater data with representative records.",
  },
  {
    match: /woocommerce/i,
    code: "WOOCOMMERCE_RUNTIME_RETAINED",
    title: "WooCommerce commerce runtime should remain authoritative",
    level: "PARTIAL",
    severity: "HIGH",
    detail: "Catalog presentation can be redesigned, but checkout, tax, order, payment and stock workflows must remain under WooCommerce until separately certified.",
    recommendation: "Use a headless or hybrid rollout and preserve WooCommerce as the system of record.",
  },
  {
    match: /contact-form-7|gravityforms|wpforms|ninja-forms/i,
    code: "FORM_REBUILD_REQUIRED",
    title: "WordPress form workflows require controlled recreation",
    level: "MANUAL",
    severity: "MEDIUM",
    detail: "Fields, conditional logic, spam controls and delivery actions vary by plugin and cannot be inferred safely from rendered markup alone.",
    recommendation: "Recreate forms in ForgeStudio and run submission, delivery and recovery acceptance tests.",
  },
  {
    match: /learndash|lifterlms|memberpress|paid-memberships-pro/i,
    code: "MEMBERSHIP_LMS_BOUNDARY",
    title: "Membership or LMS domain is not directly portable",
    level: "UNSUPPORTED",
    severity: "HIGH",
    detail: "Courses, access rules, enrolment, progress, subscriptions and protected content require a dedicated domain integration.",
    recommendation: "Retain the plugin runtime or execute a separately approved migration programme.",
  },
  {
    match: /wpml|polylang/i,
    code: "MULTILINGUAL_MAPPING_REQUIRED",
    title: "Multilingual relationships require explicit mapping",
    level: "MANUAL",
    severity: "MEDIUM",
    detail: "Language relationships, translated slugs, menus and fallback rules are plugin-specific.",
    recommendation: "Export language relationships and verify every locale before cutover.",
  },
  {
    match: /wordfence|ithemes-security|better-wp-security|sucuri/i,
    code: "SECURITY_PLUGIN_NOT_PORTABLE",
    title: "WordPress security plugins do not migrate as website content",
    level: "MANUAL",
    severity: "LOW",
    detail: "Security plugins protect the WordPress runtime and should not be converted into page-builder components.",
    recommendation: "Replace controls with platform WAF, identity, audit and runtime hardening policies.",
  },
];

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textContent(payload: unknown): string {
  const row = object(payload);
  const content = object(row.content);
  const candidates = [content.raw, content.rendered, row.content, row.post_content];
  for (const candidate of candidates) if (typeof candidate === "string") return candidate.slice(0, 2_000_000);
  return "";
}

export function discoverWordPressBlocks(sources: WordPressSourceRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  const pattern = /<!--\s*wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)/gi;
  for (const source of sources.slice(0, 10_000)) {
    const body = textContent(source.payload);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      const raw = String(match[1]).toLowerCase();
      const name = raw.includes("/") ? raw : `core/${raw}`;
      counts[name] = (counts[name] || 0) + 1;
      if (Object.keys(counts).length > 2_000) break;
    }
  }
  return counts;
}

function mergeBlockUsage(inventory: WordPressInventory, sources: WordPressSourceRecord[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [name, count] of Object.entries(inventory.block_usage || {})) {
    const value = Number(count);
    if (/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(name) && Number.isSafeInteger(value) && value > 0) result[name.toLowerCase()] = value;
  }
  for (const [name, count] of Object.entries(discoverWordPressBlocks(sources))) {
    result[name] = Math.max(result[name] || 0, count);
  }
  return result;
}

function pluginFiles(inventory: WordPressInventory): string[] {
  const values = [
    ...(Array.isArray(inventory.active_plugins) ? inventory.active_plugins : []),
    ...(Array.isArray(inventory.plugins) ? inventory.plugins.map((plugin) => plugin.file || "") : []),
  ];
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0).map((value) => value.slice(0, 300)))];
}

function grade(score: number): CompatibilityPassport["grade"] {
  return score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "E";
}

function migrationMode(score: number, unsupported: number): CompatibilityPassport["migrationMode"] {
  if (score >= 90 && unsupported === 0) return "DIRECT";
  if (score >= 65 && unsupported === 0) return "ASSISTED";
  if (score >= 40) return "HEADLESS_RETAIN";
  return "REBUILD_RECOMMENDED";
}

export function buildCompatibilityPassport(
  inventoryValue: unknown,
  sourcesValue: WordPressSourceRecord[],
): CompatibilityPassport {
  const inventory = object(inventoryValue) as WordPressInventory;
  const sources = Array.isArray(sourcesValue) ? sourcesValue.slice(0, 10_000) : [];
  const findings: CompatibilityFinding[] = [];
  const usage = mergeBlockUsage(inventory, sources);

  for (const [name, count] of Object.entries(usage).sort(([a], [b]) => a.localeCompare(b))) {
    if (NATIVE_BLOCKS.has(name)) continue;
    const partial = PARTIAL_BLOCKS.has(name) || name.startsWith("core/");
    findings.push({
      code: partial ? "BLOCK_ASSISTED_MAPPING" : "THIRD_PARTY_BLOCK_REVIEW",
      severity: partial ? "LOW" : "MEDIUM",
      category: "BLOCK",
      level: partial ? "PARTIAL" : "MANUAL",
      title: partial ? `Assisted mapping required for ${name}` : `Third-party block requires review: ${name}`,
      detail: partial
        ? "The block has a ForgeStudio migration path, but dynamic query, theme or runtime behaviour may need validation."
        : "No universal conversion contract is registered for this block namespace.",
      recommendation: partial
        ? "Preview the converted component at all breakpoints and validate dynamic behaviour."
        : "Install or build a reviewed adapter, or retain the source block through a hybrid integration.",
      count,
      samples: [name],
    });
  }

  const plugins = pluginFiles(inventory);
  const matchedPlugins = new Set<string>();
  for (const rule of PLUGIN_RULES) {
    const matches = plugins.filter((plugin) => rule.match.test(plugin));
    if (matches.length === 0) continue;
    matches.forEach((plugin) => matchedPlugins.add(plugin));
    findings.push({
      code: rule.code,
      severity: rule.severity,
      category: rule.code.startsWith("ELEMENTOR") ? "BUILDER" : "PLUGIN",
      level: rule.level,
      title: rule.title,
      detail: rule.detail,
      recommendation: rule.recommendation,
      count: matches.length,
      samples: matches.slice(0, 5),
    });
  }

  const elementorDetected = inventory.elementor?.active === true || plugins.some((plugin) => /(^|\/)elementor(-pro)?\//i.test(plugin));
  if (elementorDetected && !findings.some((finding) => finding.code === "ELEMENTOR_LAYOUTS_DETECTED")) {
    findings.push({
      code: "ELEMENTOR_LAYOUTS_DETECTED",
      severity: "MEDIUM",
      category: "BUILDER",
      level: "PARTIAL",
      title: "Elementor documents require assisted conversion",
      detail: "Elementor is active, but complete widget metadata was not available in the imported snapshot.",
      recommendation: "Install the current ForgeStudio Connect plugin, rescan inventory and validate each template in preview.",
      count: Math.max(1, Number(inventory.elementor?.documents || 0)),
      samples: [],
    });
  }

  const unmatched = plugins.filter((plugin) => !matchedPlugins.has(plugin));
  if (unmatched.length > 0) {
    findings.push({
      code: "PLUGIN_REVIEW_REQUIRED",
      severity: "LOW",
      category: "PLUGIN",
      level: "MANUAL",
      title: "Active plugins require compatibility review",
      detail: "Active WordPress plugins can add shortcodes, blocks, post types, rewrite rules or runtime behaviour that is not visible in page content.",
      recommendation: "Review the listed plugins and document whether each is retained, replaced, adapted or removed.",
      count: unmatched.length,
      samples: unmatched.slice(0, 10),
    });
  }

  if (inventory.multisite === true) {
    findings.push({
      code: "WORDPRESS_MULTISITE",
      severity: "HIGH",
      category: "OPERATIONS",
      level: "MANUAL",
      title: "WordPress Multisite requires network-level planning",
      detail: "Sites, shared users, network plugins, domains and upload paths cannot be migrated as one ordinary site.",
      recommendation: "Inventory every site and execute a network-aware migration with independent rollback points.",
      count: 1,
      samples: [],
    });
  }

  const template = String(inventory.theme?.template || "");
  if (template && !/^(twenty|hello-elementor|storefront)/i.test(template)) {
    findings.push({
      code: "CUSTOM_THEME_REVIEW",
      severity: "LOW",
      category: "THEME",
      level: "PARTIAL",
      title: "Theme-specific templates and hooks require review",
      detail: "The active theme may provide PHP templates, hooks, styles and settings that do not exist in page content.",
      recommendation: "Compare headers, footers, archives, search, 404 and structured-data output before cutover.",
      count: 1,
      samples: [template],
    });
  }

  const totals = { native: 0, partial: 0, manual: 0, unsupported: 0 };
  for (const [name, count] of Object.entries(usage)) {
    if (NATIVE_BLOCKS.has(name)) totals.native += count;
    else if (PARTIAL_BLOCKS.has(name) || name.startsWith("core/")) totals.partial += count;
    else totals.manual += count;
  }
  for (const finding of findings.filter((finding) => finding.category !== "BLOCK")) {
    if (finding.level === "NATIVE") totals.native += finding.count;
    else if (finding.level === "PARTIAL") totals.partial += finding.count;
    else if (finding.level === "MANUAL") totals.manual += finding.count;
    else totals.unsupported += finding.count;
  }

  // One unsupported business domain is a structural migration boundary, not a small warning.
  // Subsequent unsupported domains add further risk but the score remains bounded and explainable.
  const unsupportedPenalty = totals.unsupported === 0
    ? 0
    : Math.min(70, 35 + Math.max(0, totals.unsupported - 1) * 15);
  const manualPenalty = Math.min(30, totals.manual * 4);
  const partialPenalty = Math.min(20, totals.partial);
  const score = Math.max(0, Math.min(100, 100 - unsupportedPenalty - manualPenalty - partialPenalty));
  return {
    score,
    grade: grade(score),
    migrationMode: migrationMode(score, totals.unsupported),
    summary: {
      sourceItems: sources.length,
      discoveredBlocks: Object.values(usage).reduce((sum, count) => sum + count, 0),
      activePlugins: plugins.length,
      native: totals.native,
      partial: totals.partial,
      manual: totals.manual,
      unsupported: totals.unsupported,
      elementorDetected,
      woocommerceDetected: inventory.woocommerce?.active === true || plugins.some((plugin) => /woocommerce/i.test(plugin)),
      multisite: inventory.multisite === true,
    },
    findings: findings.sort((a, b) => {
      const severity = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 } as const;
      return severity[b.severity] - severity[a.severity] || a.code.localeCompare(b.code);
    }),
  };
}
