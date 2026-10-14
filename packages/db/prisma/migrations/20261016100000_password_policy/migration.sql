-- Password policy: when each local password was set, and earlier password hashes.

ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMPTZ(3);

-- Existing passwords count from their last change, so turning on expiry does not
-- expire everyone at once.
UPDATE "User" u SET "passwordChangedAt" = a."updatedAt"
  FROM "Account" a
  WHERE a."userId" = u."id" AND a."providerId" = 'credential' AND a."password" IS NOT NULL;

CREATE TABLE "PasswordHistory" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordHistory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PasswordHistory_userId_createdAt_idx" ON "PasswordHistory"("userId", "createdAt");
ALTER TABLE "PasswordHistory" ADD CONSTRAINT "PasswordHistory_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
