-- The participant numbers of blind marking are given by operations (blind marking turned
-- on, an enrolment, a submission, a grade), so that pages only read them. Assignments
-- marked blind before give theirs here to everyone enrolled in their course who has none.

DO $$
DECLARE
  r record;
  n integer;
BEGIN
  FOR r IN
    SELECT a."id" AS "activityId", e."userId"
    FROM "Activity" a
    JOIN (SELECT DISTINCT "courseId", "userId" FROM "Enrolment") e ON e."courseId" = a."courseId"
    LEFT JOIN "AssignState" s ON s."activityId" = a."id"
    WHERE a."moduleKey" = 'assign'
      AND a."deletedAt" IS NULL
      AND a."settings" @> '{"blindMarking": true}'
      AND s."identitiesRevealedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "AssignParticipant" p
        WHERE p."activityId" = a."id" AND p."userId" = e."userId"
      )
  LOOP
    LOOP
      n := 100000 + floor(random() * 900000)::integer;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "AssignParticipant" p WHERE p."activityId" = r."activityId" AND p."number" = n
      );
    END LOOP;
    INSERT INTO "AssignParticipant" ("id", "activityId", "userId", "number")
    VALUES (gen_random_uuid(), r."activityId", r."userId", n);
  END LOOP;
END $$;
