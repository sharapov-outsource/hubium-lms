-- Calculated grade items: a formula on manual items, ID numbers for categories, and ID
-- numbers unique within a course (formulas refer to items and categories by them).

ALTER TABLE "GradeItem" ADD COLUMN "calculation" TEXT;
ALTER TABLE "GradeCategory" ADD COLUMN "idNumber" TEXT;

-- blank ID numbers are none; of duplicates the first item keeps its ID number
UPDATE "GradeItem" SET "idNumber" = NULL WHERE "idNumber" IS NOT NULL AND btrim("idNumber") = '';
UPDATE "GradeItem" g SET "idNumber" = NULL
  FROM (
    SELECT id, row_number() OVER (PARTITION BY "courseId", "idNumber" ORDER BY "createdAt", id) AS n
      FROM "GradeItem" WHERE "idNumber" IS NOT NULL
  ) d
 WHERE d.id = g.id AND d.n > 1;

-- an activity's ID number is its (first) grade item's, unless another item has it already
UPDATE "GradeItem" g SET "idNumber" = a."idNumber"
  FROM "Activity" a
 WHERE g."activityId" = a.id AND g."itemNumber" = 0 AND g."idNumber" IS NULL
   AND a."idNumber" IS NOT NULL AND btrim(a."idNumber") <> ''
   AND NOT EXISTS (
     SELECT 1 FROM "GradeItem" o WHERE o."courseId" = g."courseId" AND o."idNumber" = a."idNumber"
   )
   AND a.id = (
     SELECT a2.id FROM "Activity" a2
      WHERE a2."courseId" = a."courseId" AND a2."idNumber" = a."idNumber"
      ORDER BY a2."createdAt", a2.id LIMIT 1
   );

CREATE UNIQUE INDEX "GradeItem_courseId_idNumber_key" ON "GradeItem"("courseId", "idNumber");
CREATE UNIQUE INDEX "GradeCategory_courseId_idNumber_key" ON "GradeCategory"("courseId", "idNumber");
