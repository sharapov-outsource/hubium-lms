-- Single sign-on providers (OIDC and SAML 2.0).

-- Better Auth reserves SAML assertion ids under a hash, not a UUID.
ALTER TABLE "Verification" ALTER COLUMN "id" SET DATA TYPE TEXT;

CREATE TABLE "SsoProvider" (
    "id" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "domain" TEXT NOT NULL DEFAULT '',
    "oidcConfig" TEXT,
    "samlConfig" TEXT,
    "userId" UUID NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "clientSecretEnc" TEXT,
    "spPrivateKeyEnc" TEXT,
    "spCertificate" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "autoCreate" BOOLEAN NOT NULL DEFAULT false,
    "linkByEmail" BOOLEAN NOT NULL DEFAULT true,
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SsoProvider_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SsoProvider_providerId_key" ON "SsoProvider"("providerId");
