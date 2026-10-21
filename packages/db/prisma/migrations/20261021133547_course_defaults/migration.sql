-- A course's gradebook (its root category and the course total) and the default category
-- of its question bank are made with the course, so that pages only read them. Courses
-- made before get theirs here, those in the recycle bin too: they may be restored.

INSERT INTO "GradeCategory" ("id", "courseId", "name")
SELECT gen_random_uuid(), c."id", ''
FROM "Course" c
WHERE NOT EXISTS (
  SELECT 1 FROM "GradeCategory" g WHERE g."courseId" = c."id" AND g."parentId" IS NULL
);

INSERT INTO "GradeItem" ("id", "courseId", "categoryId", "kind", "name", "gradeMax", "sortOrder", "updatedAt")
SELECT gen_random_uuid(), c."id",
  (SELECT g."id" FROM "GradeCategory" g
   WHERE g."courseId" = c."id" AND g."parentId" IS NULL
   ORDER BY g."createdAt", g."id" LIMIT 1),
  'COURSE', '', 100, 1000000, CURRENT_TIMESTAMP
FROM "Course" c
WHERE NOT EXISTS (
  SELECT 1 FROM "GradeItem" i WHERE i."courseId" = c."id" AND i."kind" = 'COURSE'
);

INSERT INTO "QuestionCategory" ("id", "contextId", "name")
SELECT gen_random_uuid(), c."id", ''
FROM "Course" c
WHERE NOT EXISTS (
  SELECT 1 FROM "QuestionCategory" q WHERE q."contextId" = c."id" AND q."parentId" IS NULL
);
