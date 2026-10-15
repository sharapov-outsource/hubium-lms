-- mod-lesson: pages and their jumps, attempts and their steps.

CREATE TABLE "LessonPage" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "contents" TEXT NOT NULL DEFAULT '',
    "answers" JSONB NOT NULL DEFAULT '[]',
    "options" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LessonPage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LessonAttempt" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "preview" BOOLEAN NOT NULL DEFAULT false,
    "currentPageId" UUID,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "percent" DOUBLE PRECISION,

    CONSTRAINT "LessonAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LessonStep" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "pageId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "answerId" TEXT,
    "response" JSONB,
    "correct" BOOLEAN NOT NULL DEFAULT false,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "essayScore" DOUBLE PRECISION,
    "essayComment" TEXT NOT NULL DEFAULT '',
    "gradedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LessonStep_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LessonPage_activityId_sortOrder_idx" ON "LessonPage"("activityId", "sortOrder");
CREATE INDEX "LessonAttempt_userId_idx" ON "LessonAttempt"("userId");
CREATE INDEX "LessonAttempt_finishedAt_dueAt_idx" ON "LessonAttempt"("finishedAt", "dueAt");
CREATE UNIQUE INDEX "LessonAttempt_activityId_userId_preview_number_key" ON "LessonAttempt"("activityId", "userId", "preview", "number");
CREATE UNIQUE INDEX "LessonStep_attemptId_seq_key" ON "LessonStep"("attemptId", "seq");
CREATE INDEX "LessonStep_pageId_idx" ON "LessonStep"("pageId");

ALTER TABLE "LessonPage" ADD CONSTRAINT "LessonPage_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LessonAttempt" ADD CONSTRAINT "LessonAttempt_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LessonAttempt" ADD CONSTRAINT "LessonAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LessonStep" ADD CONSTRAINT "LessonStep_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "LessonAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LessonStep" ADD CONSTRAINT "LessonStep_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "LessonPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
