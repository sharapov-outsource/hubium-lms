-- CreateTable
CREATE TABLE "LtiTool" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "oidcLoginUrl" TEXT NOT NULL,
    "targetLinkUri" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "jwksUrl" TEXT,
    "publicKeyPem" TEXT,
    "deepLinkingUrl" TEXT,
    "customParams" JSONB NOT NULL DEFAULT '{}',
    "sendName" BOOLEAN NOT NULL DEFAULT true,
    "sendEmail" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LtiTool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LtiPlatformKey" (
    "kid" TEXT NOT NULL,
    "publicJwk" JSONB NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "LtiPlatformKey_pkey" PRIMARY KEY ("kid")
);

-- CreateTable
CREATE TABLE "LtiNonce" (
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LtiNonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "LtiAccessToken" (
    "id" UUID NOT NULL,
    "toolId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LtiAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LtiTool_clientId_key" ON "LtiTool"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "LtiTool_deploymentId_key" ON "LtiTool"("deploymentId");

-- CreateIndex
CREATE INDEX "LtiNonce_expiresAt_idx" ON "LtiNonce"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "LtiAccessToken_tokenHash_key" ON "LtiAccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "LtiAccessToken_expiresAt_idx" ON "LtiAccessToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "LtiAccessToken" ADD CONSTRAINT "LtiAccessToken_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "LtiTool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
