import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePublishPayloadRef,
  releaseContentHash,
} from "../../workers/publish/publish-adapter.ts";

const WEBSITE = "11111111-1111-4111-8111-111111111111";

test("publish payload references are bounded and versioned", () => {
  assert.deepEqual(parsePublishPayloadRef(`artifact:publish/${WEBSITE}/42`), {
    websiteId: WEBSITE,
    sourceRevision: 42,
  });
  assert.throws(() => parsePublishPayloadRef("https://example.com/site"), /INVALID_PUBLISH_PAYLOAD_REF/);
  assert.throws(() => parsePublishPayloadRef(`artifact:publish/${WEBSITE}/-1`), /INVALID_PUBLISH_PAYLOAD_REF/);
});

test("release hashes are canonical and content-sensitive", () => {
  assert.equal(
    releaseContentHash({ b: 2, a: 1 }),
    releaseContentHash({ a: 1, b: 2 }),
  );
  assert.notEqual(
    releaseContentHash({ a: 1 }),
    releaseContentHash({ a: 2 }),
  );
});
