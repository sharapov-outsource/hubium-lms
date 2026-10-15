-- mod-wiki: wikis of an activity, their pages and the pages' versions.

CREATE TABLE "WikiSubwiki" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "groupId" UUID,
    "userId" UUID,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WikiSubwiki_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WikiPage" (
    "id" UUID NOT NULL,
    "subwikiId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 0,
    "lockedById" UUID,
    "lockedUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WikiPage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WikiVersion" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "authorId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WikiVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WikiSubwiki_userId_idx" ON "WikiSubwiki"("userId");
CREATE UNIQUE INDEX "WikiSubwiki_activityId_key_key" ON "WikiSubwiki"("activityId", "key");
CREATE UNIQUE INDEX "WikiPage_subwikiId_title_key" ON "WikiPage"("subwikiId", "title");
CREATE INDEX "WikiVersion_authorId_idx" ON "WikiVersion"("authorId");
CREATE UNIQUE INDEX "WikiVersion_pageId_version_key" ON "WikiVersion"("pageId", "version");

ALTER TABLE "WikiSubwiki" ADD CONSTRAINT "WikiSubwiki_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WikiSubwiki" ADD CONSTRAINT "WikiSubwiki_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WikiPage" ADD CONSTRAINT "WikiPage_subwikiId_fkey" FOREIGN KEY ("subwikiId") REFERENCES "WikiSubwiki"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WikiVersion" ADD CONSTRAINT "WikiVersion_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "WikiPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WikiVersion" ADD CONSTRAINT "WikiVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
