-- Assignments: group overrides with a priority, team submissions (a group's, with each
-- member's "submit"), the statement of authorship, and the late penalty applied.

ALTER TABLE "AssignOverride" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "AssignOverride_activityId_groupId_key" ON "AssignOverride"("activityId", "groupId");
ALTER TABLE "AssignOverride" ADD CONSTRAINT "AssignOverride_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssignSubmission" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "AssignSubmission"
  ADD COLUMN "groupId" UUID,
  ADD COLUMN "statementAcceptedAt" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "AssignSubmission_activityId_groupId_attemptNumber_key"
  ON "AssignSubmission"("activityId", "groupId", "attemptNumber");
ALTER TABLE "AssignSubmission" ADD CONSTRAINT "AssignSubmission_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AssignTeamSubmit" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "submittedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignTeamSubmit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssignTeamSubmit_submissionId_userId_key" ON "AssignTeamSubmit"("submissionId", "userId");
ALTER TABLE "AssignTeamSubmit" ADD CONSTRAINT "AssignTeamSubmit_submissionId_fkey"
  FOREIGN KEY ("submissionId") REFERENCES "AssignSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssignTeamSubmit" ADD CONSTRAINT "AssignTeamSubmit_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssignGrade"
  ADD COLUMN "penalty" DECIMAL(5,2),
  ADD COLUMN "lateSeconds" INTEGER;
