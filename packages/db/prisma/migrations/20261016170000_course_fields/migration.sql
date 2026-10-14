-- Custom course fields: definitions, and the values on each course.

CREATE TABLE "CourseField" (
    "id" UUID NOT NULL,
    "shortName" TEXT NOT NULL,
    "name" JSONB NOT NULL,
    "type" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CourseField_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourseField_shortName_key" ON "CourseField"("shortName");

ALTER TABLE "Course" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
