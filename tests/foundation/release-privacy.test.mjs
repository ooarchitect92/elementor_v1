import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { decryptPrivateForms, encryptPrivateForms, splitReleasePayload } from "../../workers/publish/release-payload.ts";

const WEBSITE = "11111111-1111-4111-8111-111111111111";
const RELEASE = "22222222-2222-4222-8222-222222222222";
const key = crypto.randomBytes(32).toString("base64");

const source = {
  website: { id: WEBSITE },
  editorData: {
    elements: [{
      id: "form_contact",
      fields: [{ name: "email", type: "email", required: true }],
      actions: {
        activeActions: ["database", "email", "webhook", "redirect"],
        successMessage: "Thanks",
        redirectConfig: { url: "/thanks" },
        emailConfig: { toEmail: "owner@example.test" },
        webhookConfig: { endpointUrl: "https://hooks.example.test", secretKey: "hidden-secret" },
      },
    }],
  },
};

test("public release excludes private form destinations and secrets", () => {
  const split = splitReleasePayload(source);
  const body = JSON.stringify(split.publicPayload);
  assert(!body.includes("hidden-secret"));
  assert(!body.includes("owner@example.test"));
  assert(!body.includes("hooks.example.test"));
  assert.deepEqual(split.publicPayload.editorData.elements[0].actions.activeActions, ["database", "redirect"]);
  assert.equal(split.privateForms.form_contact.actions.webhookConfig.secretKey, "hidden-secret");
});

test("private form definitions are authenticated and release-bound", () => {
  const { privateForms } = splitReleasePayload(source);
  const encrypted = encryptPrivateForms(privateForms, WEBSITE, RELEASE, key);
  assert(!encrypted.ciphertext.includes("hidden-secret"));
  const decrypted = decryptPrivateForms(encrypted, WEBSITE, RELEASE, key);
  assert.equal(decrypted.form_contact.actions.emailConfig.toEmail, "owner@example.test");
  assert.throws(() => decryptPrivateForms(encrypted, WEBSITE, "33333333-3333-4333-8333-333333333333", key));
});
