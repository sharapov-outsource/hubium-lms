-- mod-workshop: phases and forms, submissions and their assessments.

CREATE TABLE "Workshop" (
    "activityId" UUID NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'setup',
    "forms" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Workshop_pkey" PRIMARY KEY ("activityId")
);

CREATE TABLE "WorkshopSubmission" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "late" BOOLEAN NOT NULL DEFAULT false,
    "grade" DOUBLE PRECISION,
    "gradeOver" DOUBLE PRECISION,
    "feedback" TEXT NOT NULL DEFAULT '',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkshopSubmission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkshopAssessment" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "reviewerId" UUID NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "filling" JSONB,
    "grade" DOUBLE PRECISION,
    "gradingGrade" DOUBLE PRECISION,
    "gradingGradeOver" DOUBLE PRECISION,
    "feedbackAuthor" TEXT NOT NULL DEFAULT '',
    "feedbackReviewer" TEXT NOT NULL DEFAULT '',
    "assessedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkshopAssessment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkshopSubmission_activityId_authorId_key" ON "WorkshopSubmission"("activityId", "authorId");
CREATE INDEX "WorkshopAssessment_reviewerId_idx" ON "WorkshopAssessment"("reviewerId");
CREATE UNIQUE INDEX "WorkshopAssessment_submissionId_reviewerId_key" ON "WorkshopAssessment"("submissionId", "reviewerId");

ALTER TABLE "Workshop" ADD CONSTRAINT "Workshop_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkshopSubmission" ADD CONSTRAINT "WorkshopSubmission_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkshopSubmission" ADD CONSTRAINT "WorkshopSubmission_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkshopAssessment" ADD CONSTRAINT "WorkshopAssessment_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "WorkshopSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkshopAssessment" ADD CONSTRAINT "WorkshopAssessment_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
