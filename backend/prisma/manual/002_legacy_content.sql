-- Review against the legacy Prisma migration history before applying. Never run on API startup.
BEGIN;
CREATE TABLE IF NOT EXISTS websites (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
        "editorData" JSONB NOT NULL DEFAULT '{"version":1,"elements":[]}'::jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
CREATE INDEX IF NOT EXISTS idx_websites_user_id ON websites("userId");
CREATE TABLE IF NOT EXISTS templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        type VARCHAR(50) NOT NULL DEFAULT 'PAGE',
        category VARCHAR(100) NOT NULL DEFAULT 'Other',
        "isFavorite" BOOLEAN NOT NULL DEFAULT FALSE,
        "isShared" BOOLEAN NOT NULL DEFAULT FALSE,
        "shareToken" VARCHAR(255),
        "templateData" JSONB NOT NULL DEFAULT '{"elements":[],"pageSettings":{}}'::jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
ALTER TABLE templates ADD COLUMN IF NOT EXISTS category VARCHAR(100) NOT NULL DEFAULT 'Other';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS "isFavorite" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS "isShared" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS "shareToken" VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_templates_user_id ON templates("userId");
CREATE INDEX IF NOT EXISTS idx_templates_share_token ON templates("shareToken");
CREATE TABLE IF NOT EXISTS form_submissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "websiteId" UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
        "formId" VARCHAR(255) NOT NULL,
        "formName" VARCHAR(255) NOT NULL,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
CREATE INDEX IF NOT EXISTS idx_form_submissions_website_id ON form_submissions("websiteId");
CREATE INDEX IF NOT EXISTS idx_form_submissions_form_id ON form_submissions("formId");
COMMIT;
