-- A grade item's "hidden" flag is now only the teacher's choice in the gradebook: a hidden
-- or deleted activity hides its items by itself. Items that the activity sync hid for that
-- reason lose the flag here and stay hidden through their activity.
UPDATE "GradeItem" gi
SET "hidden" = false
FROM "Activity" a
WHERE gi."activityId" = a."id"
  AND gi."hidden"
  AND (a."visibility" = 'HIDDEN' OR a."deletedAt" IS NOT NULL);
