-- ForgeStudio Core v1 additive migration.
-- Review and apply explicitly. Never run from API startup.
BEGIN;

ALTER TABLE websites
  ADD COLUMN IF NOT EXISTS "performanceSettings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "currentRevision" bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS website_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "websiteId" uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision >= 0),
  "requestKey" text,
  "requestHash" char(64),
  "editorData" jsonb NOT NULL,
  "performanceSettings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "actorUserId" uuid NOT NULL REFERENCES users(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("websiteId", revision),
  UNIQUE ("websiteId", "requestKey"),
  CHECK (("requestKey" IS NULL) = ("requestHash" IS NULL))
);
CREATE INDEX IF NOT EXISTS website_revisions_created_idx
  ON website_revisions ("websiteId", "createdAt" DESC);

INSERT INTO website_revisions ("websiteId", revision, "editorData", "performanceSettings", "actorUserId")
SELECT w.id, 0, w."editorData", COALESCE(w."performanceSettings", '{}'::jsonb), w."userId"
FROM websites w
WHERE NOT EXISTS (
  SELECT 1 FROM website_revisions r WHERE r."websiteId" = w.id AND r.revision = 0
);

CREATE TABLE IF NOT EXISTS site_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "websiteId" uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  "releaseNumber" bigint NOT NULL CHECK ("releaseNumber" > 0),
  "sourceRevision" bigint NOT NULL CHECK ("sourceRevision" >= 0),
  "requestKey" text NOT NULL,
  "requestHash" char(64) NOT NULL,
  "contentHash" char(64) NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL CHECK (status IN ('VERIFIED','ACTIVE','RETIRED')),
  "createdBy" uuid NOT NULL REFERENCES users(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "activatedAt" timestamptz,
  UNIQUE ("websiteId", "releaseNumber"),
  UNIQUE ("websiteId", "requestKey")
);
CREATE UNIQUE INDEX IF NOT EXISTS site_releases_one_active_idx
  ON site_releases ("websiteId") WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS site_releases_history_idx
  ON site_releases ("websiteId", "releaseNumber" DESC);

CREATE TABLE IF NOT EXISTS wordpress_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "websiteId" uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  "siteUrl" text NOT NULL,
  "username" text NOT NULL,
  "secretCiphertext" text NOT NULL,
  "secretIv" text NOT NULL,
  "secretTag" text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED','ERROR')),
  "lastCheckedAt" timestamptz,
  "createdBy" uuid NOT NULL REFERENCES users(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("websiteId", "siteUrl")
);

CREATE TABLE IF NOT EXISTS wordpress_import_runs (
  id uuid PRIMARY KEY,
  "websiteId" uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  "connectionId" uuid NOT NULL REFERENCES wordpress_connections(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  summary jsonb,
  "errorCode" text,
  "createdBy" uuid NOT NULL REFERENCES users(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "completedAt" timestamptz
);
CREATE INDEX IF NOT EXISTS wordpress_import_runs_history_idx
  ON wordpress_import_runs ("websiteId", "connectionId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS wordpress_source_snapshots (
  "connectionId" uuid NOT NULL REFERENCES wordpress_connections(id) ON DELETE CASCADE,
  "websiteId" uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  "sourceType" text NOT NULL CHECK ("sourceType" IN ('page','post','media','term')),
  "sourceId" text NOT NULL,
  "sourceModified" text,
  "sourceHash" char(64) NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  "firstSeenAt" timestamptz NOT NULL DEFAULT now(),
  "lastSeenAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("connectionId", "sourceType", "sourceId")
);
CREATE INDEX IF NOT EXISTS wordpress_source_snapshots_site_idx
  ON wordpress_source_snapshots ("websiteId", "sourceType", "lastSeenAt" DESC);

COMMIT;
