import test from "node:test";
import assert from "node:assert/strict";
import { contentHash, mergeEditorData } from "../../backend/src/modules/core-v1/editor-merge.ts";

test("partial design saves preserve omitted pages, popups and global settings", () => {
  const current = {
    elements: [{ id: "hero", content: "old" }],
    pages: [{ id: "home", slug: "/", elements: [{ id: "p1", content: "page" }] }],
    popups: [{ id: "sale", elements: [{ id: "x", content: "popup" }] }],
    globalSettings: { fonts: ["Inter"] },
  };
  const merged = mergeEditorData(current, { elements: [{ id: "hero", content: "new" }] }, true, true, new Set());
  assert.equal(merged.elements[0].content, "new");
  assert.deepEqual(merged.pages, current.pages);
  assert.deepEqual(merged.popups, current.popups);
  assert.deepEqual(merged.globalSettings, current.globalSettings);
});

test("content-only saves cannot change styles, delete nodes or add nodes", () => {
  const current = { elements: [{ id: "a", content: "old", styles: { color: "red" } }, { id: "b", content: "keep" }] };
  const incoming = { elements: [{ id: "a", content: "new", styles: { color: "black" } }, { id: "new", content: "inject" }] };
  const merged = mergeEditorData(current, incoming, false, false, new Set());
  assert.equal(merged.elements[0].content, "new");
  assert.deepEqual(merged.elements[0].styles, { color: "red" });
  assert.equal(merged.elements[1].id, "b");
  assert.equal(merged.elements.length, 2);
});

test("protected elements cannot be removed by non-admin design collaborators", () => {
  const current = { elements: [{ id: "protected", content: "safe", isProtected: true }, { id: "free", content: "free" }] };
  const merged = mergeEditorData(current, { elements: [{ id: "free", content: "changed" }] }, true, false, new Set());
  assert.ok(merged.elements.some((el) => el.id === "protected" && el.content === "safe"));
});

test("explicit component access permits changing a protected element", () => {
  const current = { elements: [{ id: "protected", content: "safe", isProtected: true }] };
  const merged = mergeEditorData(current, { elements: [{ id: "protected", content: "allowed", isProtected: true }] }, true, false, new Set(["protected"]));
  assert.equal(merged.elements[0].content, "allowed");
});

test("content hash is stable across object key order", () => {
  assert.equal(contentHash({ b: 2, a: { d: 4, c: 3 } }), contentHash({ a: { c: 3, d: 4 }, b: 2 }));
});
