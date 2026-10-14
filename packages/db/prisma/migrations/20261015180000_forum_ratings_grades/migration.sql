-- Forum ratings (one per post and rater) and whole-forum grades.

CREATE TABLE "ForumRating" (
    "id" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "raterId" UUID NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ForumRating_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ForumRating_postId_raterId_key" ON "ForumRating"("postId", "raterId");
CREATE INDEX "ForumRating_raterId_idx" ON "ForumRating"("raterId");
ALTER TABLE "ForumRating" ADD CONSTRAINT "ForumRating_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "ForumPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ForumRating" ADD CONSTRAINT "ForumRating_raterId_fkey"
  FOREIGN KEY ("raterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ForumGrade" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "grade" DECIMAL(12,5),
    "feedback" TEXT NOT NULL DEFAULT '',
    "graderId" UUID,
    "gradedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumGrade_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ForumGrade_activityId_userId_key" ON "ForumGrade"("activityId", "userId");
ALTER TABLE "ForumGrade" ADD CONSTRAINT "ForumGrade_activityId_fkey"
  FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ForumGrade" ADD CONSTRAINT "ForumGrade_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ForumGrade" ADD CONSTRAINT "ForumGrade_graderId_fkey"
  FOREIGN KEY ("graderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
