-- One forum-level subscription for each person. The unique key on (activityId, userId,
-- discussionId) lets the rows without a discussion repeat, as nulls differ: keep the
-- latest of any repeats, then a partial unique index (made by hand: see raw-indexes.mjs).
DELETE FROM "ForumSubscription" a
 USING "ForumSubscription" b
 WHERE a."discussionId" IS NULL AND b."discussionId" IS NULL
   AND a."activityId" = b."activityId" AND a."userId" = b."userId"
   AND a."id" < b."id";

CREATE UNIQUE INDEX "ForumSubscription_forum_level_key"
  ON "ForumSubscription"("activityId", "userId")
  WHERE "discussionId" IS NULL;
