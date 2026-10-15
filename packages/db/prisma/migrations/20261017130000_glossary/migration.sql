-- mod-glossary: entries of glossaries and their ratings.

CREATE TABLE "GlossaryEntry" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "authorId" UUID,
    "concept" TEXT NOT NULL,
    "definition" TEXT NOT NULL DEFAULT '',
    "aliases" TEXT[],
    "categories" TEXT[],
    "approved" BOOLEAN NOT NULL DEFAULT true,
    "autoLink" BOOLEAN NOT NULL DEFAULT false,
    "caseSensitive" BOOLEAN NOT NULL DEFAULT false,
    "fullMatch" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GlossaryEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GlossaryRating" (
    "id" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "raterId" UUID NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GlossaryRating_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GlossaryEntry_activityId_concept_idx" ON "GlossaryEntry"("activityId", "concept");
CREATE INDEX "GlossaryEntry_authorId_idx" ON "GlossaryEntry"("authorId");
CREATE UNIQUE INDEX "GlossaryRating_entryId_raterId_key" ON "GlossaryRating"("entryId", "raterId");
CREATE INDEX "GlossaryRating_raterId_idx" ON "GlossaryRating"("raterId");

ALTER TABLE "GlossaryEntry" ADD CONSTRAINT "GlossaryEntry_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GlossaryEntry" ADD CONSTRAINT "GlossaryEntry_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GlossaryRating" ADD CONSTRAINT "GlossaryRating_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "GlossaryEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GlossaryRating" ADD CONSTRAINT "GlossaryRating_raterId_fkey" FOREIGN KEY ("raterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
