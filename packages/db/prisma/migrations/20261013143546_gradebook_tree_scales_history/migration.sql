-- AlterTable
ALTER TABLE "GradeCategory" ADD COLUMN     "weight" DECIMAL(12,5) NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "GradeHistory" ADD COLUMN     "overridden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "previousGrade" DECIMAL(12,5);

-- CreateIndex
CREATE INDEX "Scale_courseId_idx" ON "Scale"("courseId");

-- Rows without their course or context (nothing wrote these tables before).
DELETE FROM "Scale" WHERE "courseId" IS NOT NULL AND "courseId" NOT IN (SELECT id FROM "Course");
DELETE FROM "GradeLetter" WHERE "contextId" NOT IN (SELECT id FROM "Context");

-- AddForeignKey
ALTER TABLE "Scale" ADD CONSTRAINT "Scale_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeLetter" ADD CONSTRAINT "GradeLetter_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "Context"("id") ON DELETE CASCADE ON UPDATE CASCADE;
