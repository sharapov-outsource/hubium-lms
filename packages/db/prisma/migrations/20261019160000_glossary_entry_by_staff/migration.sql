-- Glossary entries remember whether their author managed the glossary when writing them,
-- so a course reset keeps teachers' entries and backups carry them after the author has
-- left the course.
ALTER TABLE "GlossaryEntry" ADD COLUMN     "byStaff" BOOLEAN NOT NULL DEFAULT false;

-- Existing entries: those without an author (imported) and those whose author is a site
-- administrator or still holds a manager or teacher role in the course, the activity or
-- the site, whatever their enrolment's state.
UPDATE "GlossaryEntry" e
SET "byStaff" = true
FROM "Activity" a
WHERE e."activityId" = a."id"
  AND (
    e."authorId" IS NULL
    OR EXISTS (SELECT 1 FROM "User" u WHERE u."id" = e."authorId" AND u."isSiteAdmin")
    OR EXISTS (
      SELECT 1
      FROM "RoleAssignment" ra
      JOIN "Role" r ON r."id" = ra."roleId"
      WHERE ra."userId" = e."authorId"
        AND ra."contextId" IN (a."courseId", a."id", '00000000-0000-7000-8000-000000000001')
        AND r."archetype" IN ('MANAGER', 'EDITINGTEACHER', 'TEACHER')
    )
  );
