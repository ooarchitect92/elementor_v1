-- Private release configuration is encrypted separately from the public rendering payload.
BEGIN;

CREATE TABLE IF NOT EXISTS site_release_private (
  "releaseId" uuid PRIMARY KEY REFERENCES site_releases(id) ON DELETE CASCADE,
  "websiteId" uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  "formDefinitionsCiphertext" text NOT NULL,
  "formDefinitionsIv" text NOT NULL,
  "formDefinitionsTag" text NOT NULL,
  "keyVersion" integer NOT NULL DEFAULT 1 CHECK("keyVersion" > 0),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_release_private_website_idx
  ON site_release_private("websiteId","createdAt" DESC);

COMMIT;
