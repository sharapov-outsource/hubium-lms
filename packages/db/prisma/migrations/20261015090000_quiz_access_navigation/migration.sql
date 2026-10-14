-- Quiz access rules and navigation: the page an attempt is on (sequential navigation
-- cannot go back) and a password per override.
ALTER TABLE "QuizAttempt" ADD COLUMN "currentPage" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "QuizOverride" ADD COLUMN "password" TEXT;

-- Pages now belong to the slots. Lay out the existing quizzes as "questions per page"
-- did, so they look the same: perPage 0 kept everything on one page.
UPDATE "QuizSlot" s
SET "page" = CASE
  WHEN COALESCE((a."settings"->>'perPage')::int, 1) <= 0 THEN 1
  ELSE (s."slot" - 1) / COALESCE((a."settings"->>'perPage')::int, 1) + 1
END
FROM "Activity" a
WHERE a."id" = s."activityId";
