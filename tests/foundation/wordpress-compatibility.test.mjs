import assert from "node:assert/strict";
import test from "node:test";

import { buildCompatibilityPassport, discoverWordPressBlocks } from "../../backend/src/modules/wordpress/compatibility.ts";

const sources = [
  {
    sourceType: "page",
    sourceId: "1",
    payload: {
      content: {
        raw: "<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph --><!-- wp:woocommerce/product-price /--><!-- wp:core/navigation /-->",
      },
    },
  },
] as const;

test("discovers Gutenberg core and third-party blocks", () => {
  const usage = discoverWordPressBlocks([...sources]);
  assert.equal(usage["core/paragraph"], 1);
  assert.equal(usage["woocommerce/product-price"], 1);
  assert.equal(usage["core/navigation"], 1);
});

test("compatibility passport is deterministic and exposes migration boundaries", () => {
  const inventory = {
    wordpress_version: "6.8",
    multisite: false,
    theme: { template: "custom-agency-theme" },
    active_plugins: [
      "elementor/elementor.php",
      "woocommerce/woocommerce.php",
      "learndash/learndash.php",
    ],
    elementor: { active: true, documents: 12 },
    woocommerce: { active: true },
  };
  const first = buildCompatibilityPassport(inventory, [...sources]);
  const second = buildCompatibilityPassport(inventory, [...sources]);
  assert.deepEqual(first, second);
  assert.equal(first.summary.elementorDetected, true);
  assert.equal(first.summary.woocommerceDetected, true);
  assert.ok(first.summary.unsupported > 0);
  assert.ok(first.score < 65);
  assert.equal(first.migrationMode, "HEADLESS_RETAIN");
  assert.ok(first.findings.some((finding) => finding.code === "MEMBERSHIP_LMS_BOUNDARY"));
});

test("simple core-block site qualifies for a direct path", () => {
  const result = buildCompatibilityPassport(
    { wordpress_version: "6.8", theme: { template: "twentytwentyfive" }, active_plugins: [] },
    [{ sourceType: "page", sourceId: "1", payload: { content: { raw: "<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->" } } }],
  );
  assert.equal(result.grade, "A");
  assert.equal(result.migrationMode, "DIRECT");
  assert.equal(result.summary.native, 1);
});
