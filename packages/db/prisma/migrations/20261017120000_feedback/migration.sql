-- mod-feedback: questions of a survey and the answers to it.

CREATE TABLE "FeedbackItem" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "FeedbackItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FeedbackResponse" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "anonymous" BOOLEAN NOT NULL,
    "answers" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackResponse_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FeedbackItem_activityId_sortOrder_idx" ON "FeedbackItem"("activityId", "sortOrder");
CREATE INDEX "FeedbackResponse_activityId_createdAt_idx" ON "FeedbackResponse"("activityId", "createdAt");
CREATE INDEX "FeedbackResponse_userId_idx" ON "FeedbackResponse"("userId");

ALTER TABLE "FeedbackItem" ADD CONSTRAINT "FeedbackItem_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeedbackResponse" ADD CONSTRAINT "FeedbackResponse_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeedbackResponse" ADD CONSTRAINT "FeedbackResponse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
