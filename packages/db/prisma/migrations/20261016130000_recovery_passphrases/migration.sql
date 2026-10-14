-- Recovery passphrases for two-factor authentication.

CREATE TABLE "RecoveryPassphrase" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryPassphrase_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RecoveryPassphrase_userId_idx" ON "RecoveryPassphrase"("userId");
ALTER TABLE "RecoveryPassphrase" ADD CONSTRAINT "RecoveryPassphrase_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
