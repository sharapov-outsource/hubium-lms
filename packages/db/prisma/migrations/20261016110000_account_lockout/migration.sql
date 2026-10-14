-- Account lockout after repeated failed sign-ins.

ALTER TABLE "User" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "failedLoginAt" TIMESTAMPTZ(3);
ALTER TABLE "User" ADD COLUMN "lockedUntil" TIMESTAMPTZ(3);
