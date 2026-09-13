import assert from "node:assert/strict";
import test from "node:test";

import { planTrustedDeliveryActions } from "../../backend/src/modules/integrations-v2/action-planner.ts";
import { encryptDeliveryConfig } from "../../backend/src/modules/integrations-v2/delivery-crypto.ts";
import { decryptDeliveryConfig } from "../../workers/integrations/secret-envelope.ts";
import { isPublicAddress } from "../../packages/platform/safe-http.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

process.env.INTEGRATION_SECRET_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");

test("delivery configuration encryption round-trips only with matching scope", () => {
  const config = { provider: "WEBHOOK", endpointUrl: "https://example.com/lead", secretKey: "secret" };
  const encrypted = encryptDeliveryConfig(config, tenantId, jobId);
  assert.deepEqual(decryptDeliveryConfig(encrypted, tenantId, jobId), config);
  assert.throws(
    () => decryptDeliveryConfig(encrypted, tenantId, "33333333-3333-4333-8333-333333333333"),
  );
});

test("trusted action planner accepts bounded supported providers", () => {
  const plan = planTrustedDeliveryActions({
    activeActions: ["database", "email", "webhook", "crm"],
    emailConfig: {
      provider: "sendgrid",
      toEmail: "lead@example.com",
      fromEmail: "forms@example.com",
      apiKey: "SG.this-is-a-long-test-key",
      subject: "New lead",
    },
    webhookConfig: { endpointUrl: "https://hooks.example.com/forms", secretKey: "secret" },
    crmConfig: { provider: "hubspot", accessToken: "pat-this-is-a-long-test-token", emailField: "email" },
  });
  assert.equal(plan.actions.length, 3);
  assert.equal(plan.rejected.length, 0);
  assert.deepEqual(plan.actions.map((action) => action.type), ["EMAIL", "WEBHOOK", "CRM"]);
});

test("trusted action planner records invalid destinations rather than fabricating delivery", () => {
  const plan = planTrustedDeliveryActions({
    activeActions: ["email", "webhook", "crm"],
    emailConfig: { provider: "unknown" },
    webhookConfig: { endpointUrl: "http://127.0.0.1/private" },
    crmConfig: { provider: "unsupported" },
  });
  assert.equal(plan.actions.length, 0);
  assert.deepEqual(
    plan.rejected.map((item) => item.code),
    ["EMAIL_PROVIDER_UNSUPPORTED", "WEBHOOK_CONFIGURATION_INVALID", "CRM_PROVIDER_UNSUPPORTED"],
  );
});

test("outbound address policy rejects private and reserved networks", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "fe80::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});
