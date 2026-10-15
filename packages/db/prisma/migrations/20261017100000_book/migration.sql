-- mod-book: chapters and subchapters of a book.

CREATE TABLE "BookChapter" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "subchapter" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BookChapter_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BookChapter_activityId_sortOrder_idx" ON "BookChapter"("activityId", "sortOrder");

ALTER TABLE "BookChapter" ADD CONSTRAINT "BookChapter_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
