-- Assignment marking: workflow and allocated markers, blind marking (participant numbers,
-- identities revealed), and advanced grading forms (rubrics, marking guides) with their
-- fillings, shared by modules.

CREATE TYPE "AssignWorkflowState" AS ENUM ('NOTMARKED', 'INMARKING', 'READYFORREVIEW', 'INREVIEW', 'READYFORRELEASE', 'RELEASED');
CREATE TYPE "GradingMethod" AS ENUM ('RUBRIC', 'GUIDE');

CREATE TABLE "AssignUserFlags" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workflowState" "AssignWorkflowState" NOT NULL DEFAULT 'NOTMARKED',
    "allocatedMarkerId" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AssignUserFlags_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssignUserFlags_activityId_userId_key" ON "AssignUserFlags"("activityId", "userId");
ALTER TABLE "AssignUserFlags" ADD CONSTRAINT "AssignUserFlags_activityId_fkey"
  FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssignUserFlags" ADD CONSTRAINT "AssignUserFlags_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssignUserFlags" ADD CONSTRAINT "AssignUserFlags_allocatedMarkerId_fkey"
  FOREIGN KEY ("allocatedMarkerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AssignParticipant" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "number" INTEGER NOT NULL,

    CONSTRAINT "AssignParticipant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssignParticipant_activityId_userId_key" ON "AssignParticipant"("activityId", "userId");
CREATE UNIQUE INDEX "AssignParticipant_activityId_number_key" ON "AssignParticipant"("activityId", "number");
ALTER TABLE "AssignParticipant" ADD CONSTRAINT "AssignParticipant_activityId_fkey"
  FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssignParticipant" ADD CONSTRAINT "AssignParticipant_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AssignState" (
    "activityId" UUID NOT NULL,
    "identitiesRevealedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AssignState_pkey" PRIMARY KEY ("activityId")
);
ALTER TABLE "AssignState" ADD CONSTRAINT "AssignState_activityId_fkey"
  FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "GradingDefinition" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "area" TEXT NOT NULL DEFAULT 'submission',
    "method" "GradingMethod" NOT NULL,
    "definition" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GradingDefinition_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GradingDefinition_activityId_area_method_key" ON "GradingDefinition"("activityId", "area", "method");
ALTER TABLE "GradingDefinition" ADD CONSTRAINT "GradingDefinition_activityId_fkey"
  FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "GradingInstance" (
    "id" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 0,
    "raterId" UUID,
    "filling" JSONB NOT NULL,
    "grade" DECIMAL(12,5),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GradingInstance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GradingInstance_definitionId_userId_attemptNumber_key" ON "GradingInstance"("definitionId", "userId", "attemptNumber");
ALTER TABLE "GradingInstance" ADD CONSTRAINT "GradingInstance_definitionId_fkey"
  FOREIGN KEY ("definitionId") REFERENCES "GradingDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GradingInstance" ADD CONSTRAINT "GradingInstance_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
