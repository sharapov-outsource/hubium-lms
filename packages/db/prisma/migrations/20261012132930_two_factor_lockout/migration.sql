-- AlterTable
ALTER TABLE "TwoFactor" ADD COLUMN     "failedVerificationCount" INTEGER DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMPTZ(3),
ADD COLUMN     "verified" BOOLEAN DEFAULT true;
