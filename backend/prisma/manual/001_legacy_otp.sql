-- Run only against the existing legacy schema after review; NOT an automatic startup action.
-- This preserves the prior idempotent repair operations outside API imports.
BEGIN;
ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'EMAIL_SIGNUP';
ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'EMAIL_LOGIN';
ALTER TABLE "otp_verifications" ADD COLUMN IF NOT EXISTS "email" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OtpChannel') THEN
    CREATE TYPE "OtpChannel" AS ENUM ('EMAIL','WHATSAPP');
  END IF;
END $$;
ALTER TABLE "otp_verifications" ADD COLUMN IF NOT EXISTS "channel" "OtpChannel" DEFAULT 'EMAIL';
COMMIT;
