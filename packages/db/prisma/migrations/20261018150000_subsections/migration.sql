-- Subsections: a course section inside another one, among its activities.

ALTER TABLE "CourseSection" ADD COLUMN "parentId" UUID;

CREATE INDEX "CourseSection_parentId_idx" ON "CourseSection"("parentId");

ALTER TABLE "CourseSection" ADD CONSTRAINT "CourseSection_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CourseSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
