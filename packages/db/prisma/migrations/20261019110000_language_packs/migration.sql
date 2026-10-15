-- Language packs installed from the interface.

CREATE TABLE "LanguagePack" (
    "code" TEXT NOT NULL,
    "core" JSONB NOT NULL,
    "modules" JSONB NOT NULL DEFAULT '{}',
    "installedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LanguagePack_pkey" PRIMARY KEY ("code")
);
