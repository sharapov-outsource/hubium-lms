-- Competencies and learning plans: frameworks, links to courses and activities, ratings,
-- evidence, plan templates, plans, evidence of prior learning and comments.

CREATE TYPE "CompetencyOutcome" AS ENUM ('NONE', 'EVIDENCE', 'RECOMMEND', 'COMPLETE');

CREATE TYPE "CompetencyRuleType" AS ENUM ('ALL', 'POINTS');

CREATE TYPE "UserCompetencyStatus" AS ENUM ('IDLE', 'WAITING_FOR_REVIEW', 'IN_REVIEW');

CREATE TYPE "LearningPlanStatus" AS ENUM ('DRAFT', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'ACTIVE', 'COMPLETE');

CREATE TYPE "CompetencyEvidenceAction" AS ENUM ('LOG', 'COMPLETE', 'OVERRIDE');

CREATE TABLE "CompetencyFramework" (
    "id" UUID NOT NULL,
    "shortName" TEXT NOT NULL,
    "idNumber" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "scaleId" UUID NOT NULL,
    "scaleConfig" JSONB NOT NULL,
    "taxonomies" TEXT[],
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CompetencyFramework_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Competency" (
    "id" UUID NOT NULL,
    "frameworkId" UUID NOT NULL,
    "parentId" UUID,
    "path" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "shortName" TEXT NOT NULL,
    "idNumber" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "scaleId" UUID,
    "scaleConfig" JSONB,
    "ruleType" "CompetencyRuleType",
    "ruleOutcome" "CompetencyOutcome" NOT NULL DEFAULT 'NONE',
    "ruleConfig" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Competency_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RelatedCompetency" (
    "competencyId" UUID NOT NULL,
    "relatedId" UUID NOT NULL,

    CONSTRAINT "RelatedCompetency_pkey" PRIMARY KEY ("competencyId","relatedId")
);

CREATE TABLE "CourseCompetency" (
    "id" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "competencyId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "ruleOutcome" "CompetencyOutcome" NOT NULL DEFAULT 'NONE',

    CONSTRAINT "CourseCompetency_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CourseCompetencySettings" (
    "courseId" UUID NOT NULL,
    "pushRatings" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CourseCompetencySettings_pkey" PRIMARY KEY ("courseId")
);

CREATE TABLE "ActivityCompetency" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "competencyId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "ruleOutcome" "CompetencyOutcome" NOT NULL DEFAULT 'NONE',

    CONSTRAINT "ActivityCompetency_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserCompetency" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "competencyId" UUID NOT NULL,
    "status" "UserCompetencyStatus" NOT NULL DEFAULT 'IDLE',
    "reviewerId" UUID,
    "grade" INTEGER,
    "proficiency" BOOLEAN,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UserCompetency_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserCompetencyCourse" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "competencyId" UUID NOT NULL,
    "grade" INTEGER,
    "proficiency" BOOLEAN,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UserCompetencyCourse_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserCompetencyPlan" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "competencyId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "grade" INTEGER,
    "proficiency" BOOLEAN,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCompetencyPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompetencyEvidence" (
    "id" UUID NOT NULL,
    "userCompetencyId" UUID NOT NULL,
    "action" "CompetencyEvidenceAction" NOT NULL,
    "contextId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "descriptionData" JSONB,
    "grade" INTEGER,
    "note" TEXT,
    "url" TEXT,
    "actorId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetencyEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompetencyComment" (
    "id" UUID NOT NULL,
    "userCompetencyId" UUID,
    "planId" UUID,
    "authorId" UUID,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetencyComment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearningPlanTemplate" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "dueDate" TIMESTAMPTZ(3),
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LearningPlanTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearningPlanTemplateCompetency" (
    "templateId" UUID NOT NULL,
    "competencyId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LearningPlanTemplateCompetency_pkey" PRIMARY KEY ("templateId","competencyId")
);

CREATE TABLE "LearningPlanTemplateCohort" (
    "templateId" UUID NOT NULL,
    "cohortId" UUID NOT NULL,

    CONSTRAINT "LearningPlanTemplateCohort_pkey" PRIMARY KEY ("templateId","cohortId")
);

CREATE TABLE "LearningPlan" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "templateId" UUID,
    "origTemplateId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "dueDate" TIMESTAMPTZ(3),
    "status" "LearningPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewerId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LearningPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearningPlanCompetency" (
    "planId" UUID NOT NULL,
    "competencyId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LearningPlanCompetency_pkey" PRIMARY KEY ("planId","competencyId")
);

CREATE TABLE "UserEvidence" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UserEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserEvidenceCompetency" (
    "userEvidenceId" UUID NOT NULL,
    "competencyId" UUID NOT NULL,

    CONSTRAINT "UserEvidenceCompetency_pkey" PRIMARY KEY ("userEvidenceId","competencyId")
);

CREATE UNIQUE INDEX "CompetencyFramework_idNumber_key" ON "CompetencyFramework"("idNumber");

CREATE INDEX "Competency_parentId_idx" ON "Competency"("parentId");

CREATE INDEX "Competency_frameworkId_path_idx" ON "Competency"("frameworkId", "path");

CREATE UNIQUE INDEX "Competency_frameworkId_idNumber_key" ON "Competency"("frameworkId", "idNumber");

CREATE INDEX "CourseCompetency_competencyId_idx" ON "CourseCompetency"("competencyId");

CREATE UNIQUE INDEX "CourseCompetency_courseId_competencyId_key" ON "CourseCompetency"("courseId", "competencyId");

CREATE INDEX "ActivityCompetency_competencyId_idx" ON "ActivityCompetency"("competencyId");

CREATE UNIQUE INDEX "ActivityCompetency_activityId_competencyId_key" ON "ActivityCompetency"("activityId", "competencyId");

CREATE INDEX "UserCompetency_competencyId_idx" ON "UserCompetency"("competencyId");

CREATE UNIQUE INDEX "UserCompetency_userId_competencyId_key" ON "UserCompetency"("userId", "competencyId");

CREATE INDEX "UserCompetencyCourse_courseId_idx" ON "UserCompetencyCourse"("courseId");

CREATE UNIQUE INDEX "UserCompetencyCourse_userId_courseId_competencyId_key" ON "UserCompetencyCourse"("userId", "courseId", "competencyId");

CREATE UNIQUE INDEX "UserCompetencyPlan_planId_competencyId_key" ON "UserCompetencyPlan"("planId", "competencyId");

CREATE INDEX "CompetencyEvidence_userCompetencyId_createdAt_idx" ON "CompetencyEvidence"("userCompetencyId", "createdAt");

CREATE INDEX "CompetencyComment_userCompetencyId_idx" ON "CompetencyComment"("userCompetencyId");

CREATE INDEX "CompetencyComment_planId_idx" ON "CompetencyComment"("planId");

CREATE INDEX "LearningPlan_templateId_idx" ON "LearningPlan"("templateId");

CREATE UNIQUE INDEX "LearningPlan_userId_templateId_key" ON "LearningPlan"("userId", "templateId");

CREATE INDEX "UserEvidence_userId_idx" ON "UserEvidence"("userId");

ALTER TABLE "CompetencyFramework" ADD CONSTRAINT "CompetencyFramework_scaleId_fkey" FOREIGN KEY ("scaleId") REFERENCES "Scale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Competency" ADD CONSTRAINT "Competency_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "CompetencyFramework"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Competency" ADD CONSTRAINT "Competency_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Competency"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "Competency" ADD CONSTRAINT "Competency_scaleId_fkey" FOREIGN KEY ("scaleId") REFERENCES "Scale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RelatedCompetency" ADD CONSTRAINT "RelatedCompetency_competencyId_fkey" FOREIGN KEY ("competencyId") REFERENCES "Competency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RelatedCompetency" ADD CONSTRAINT "RelatedCompetency_relatedId_fkey" FOREIGN KEY ("relatedId") REFERENCES "Competency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CourseCompetency" ADD CONSTRAINT "CourseCompetency_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CourseCompetency" ADD CONSTRAINT "CourseCompetency_competencyId_fkey" FOREIGN KEY ("competencyId") REFERENCES "Competency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CourseCompetencySettings" ADD CONSTRAINT "CourseCompetencySettings_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActivityCompetency" ADD CONSTRAINT "ActivityCompetency_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActivityCompetency" ADD CONSTRAINT "ActivityCompetency_competencyId_fkey" FOREIGN KEY ("competencyId") REFERENCES "Competency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserCompetency" ADD CONSTRAINT "UserCompetency_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserCompetency" ADD CONSTRAINT "UserCompetency_competencyId_fkey" FOREIGN KEY ("competencyId") REFERENCES "Competency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserCompetencyCourse" ADD CONSTRAINT "UserCompetencyCourse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserCompetencyCourse" ADD CONSTRAINT "UserCompetencyCourse_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserCompetencyCourse" ADD CONSTRAINT "UserCompetencyCourse_competencyId_fkey" FOREIGN KEY ("competencyId") REFERENCES "Competency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserCompetencyPlan" ADD CONSTRAINT "UserCompetencyPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserCompetencyPlan" ADD CONSTRAINT "UserCompetencyPlan_competencyId_fkey" FOREIGN KEY ("competencyId") REFERENCES "Competency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserCompetencyPlan" ADD CONSTRAINT "UserCompetencyPlan_planId_fkey" FOREIGN KEY ("planId") REFERENCES "LearningPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CompetencyEvidence" ADD CONSTRAINT "CompetencyEvidence_userCompetencyId_fkey" FOREIGN KEY ("userCompetencyId") REFERENCES "UserCompetency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CompetencyComment" ADD CONSTRAINT "CompetencyComment_userCompetencyId_fkey" FOREIGN KEY ("userCompetencyId") REFERENCES "UserCompetency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CompetencyComment" ADD CONSTRAINT "CompetencyComment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "LearningPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CompetencyComment" ADD CONSTRAINT "CompetencyComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LearningPlanTemplateCompetency" ADD CONSTRAINT "LearningPlanTemplateCompetency_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "LearningPlanTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearningPlanTemplateCompetency" ADD CONSTRAINT "LearningPlanTemplateCompetency_competencyId_fkey" FOREIGN KEY ("competencyId") REFERENCES "Competency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearningPlanTemplateCohort" ADD CONSTRAINT "LearningPlanTemplateCohort_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "LearningPlanTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearningPlanTemplateCohort" ADD CONSTRAINT "LearningPlanTemplateCohort_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearningPlan" ADD CONSTRAINT "LearningPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearningPlan" ADD CONSTRAINT "LearningPlan_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "LearningPlanTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LearningPlanCompetency" ADD CONSTRAINT "LearningPlanCompetency_planId_fkey" FOREIGN KEY ("planId") REFERENCES "LearningPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearningPlanCompetency" ADD CONSTRAINT "LearningPlanCompetency_competencyId_fkey" FOREIGN KEY ("competencyId") REFERENCES "Competency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserEvidence" ADD CONSTRAINT "UserEvidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserEvidenceCompetency" ADD CONSTRAINT "UserEvidenceCompetency_userEvidenceId_fkey" FOREIGN KEY ("userEvidenceId") REFERENCES "UserEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserEvidenceCompetency" ADD CONSTRAINT "UserEvidenceCompetency_competencyId_fkey" FOREIGN KEY ("competencyId") REFERENCES "Competency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
