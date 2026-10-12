-- CreateEnum
CREATE TYPE "GradeAggregation" AS ENUM ('NATURAL', 'MEAN', 'WEIGHTED_MEAN', 'HIGHEST', 'LOWEST', 'MEDIAN');

-- CreateEnum
CREATE TYPE "GradeItemKind" AS ENUM ('MODULE', 'MANUAL', 'CATEGORY', 'COURSE');

-- CreateEnum
CREATE TYPE "GradeType" AS ENUM ('VALUE', 'SCALE', 'TEXT', 'NONE');

-- CreateEnum
CREATE TYPE "GradeDisplay" AS ENUM ('REAL', 'PERCENT', 'LETTER');

-- CreateEnum
CREATE TYPE "AssignSubmissionStatus" AS ENUM ('NEW', 'DRAFT', 'SUBMITTED', 'REOPENED');

-- CreateEnum
CREATE TYPE "QuizSlotKind" AS ENUM ('FIXED', 'RANDOM');

-- CreateEnum
CREATE TYPE "QuizAttemptState" AS ENUM ('IN_PROGRESS', 'OVERDUE', 'FINISHED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('MULTICHOICE', 'TRUEFALSE', 'SHORTANSWER', 'NUMERICAL', 'MATCH', 'ESSAY', 'DESCRIPTION');

-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('DRAFT', 'READY', 'HIDDEN');

-- CreateEnum
CREATE TYPE "QuestionSource" AS ENUM ('MANUAL', 'IMPORT', 'AI');

-- CreateTable
CREATE TABLE "Scale" (
    "id" UUID NOT NULL,
    "courseId" UUID,
    "name" TEXT NOT NULL,
    "items" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Scale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradeLetter" (
    "id" UUID NOT NULL,
    "contextId" UUID NOT NULL,
    "lowerBound" DECIMAL(6,2) NOT NULL,
    "letter" TEXT NOT NULL,

    CONSTRAINT "GradeLetter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradeCategory" (
    "id" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "aggregation" "GradeAggregation" NOT NULL DEFAULT 'NATURAL',
    "dropLowest" INTEGER NOT NULL DEFAULT 0,
    "keepHighest" INTEGER NOT NULL DEFAULT 0,
    "aggregateOnlyGraded" BOOLEAN NOT NULL DEFAULT true,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GradeCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradeItem" (
    "id" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "categoryId" UUID,
    "kind" "GradeItemKind" NOT NULL,
    "activityId" UUID,
    "moduleKey" TEXT,
    "itemNumber" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "idNumber" TEXT,
    "gradeType" "GradeType" NOT NULL DEFAULT 'VALUE',
    "gradeMin" DECIMAL(12,5) NOT NULL DEFAULT 0,
    "gradeMax" DECIMAL(12,5) NOT NULL DEFAULT 100,
    "gradePass" DECIMAL(12,5),
    "scaleId" UUID,
    "weight" DECIMAL(12,5) NOT NULL DEFAULT 1,
    "decimals" INTEGER NOT NULL DEFAULT 2,
    "display" "GradeDisplay" NOT NULL DEFAULT 'REAL',
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "hiddenUntil" TIMESTAMPTZ(3),
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "needsUpdate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GradeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Grade" (
    "id" UUID NOT NULL,
    "gradeItemId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "rawGrade" DECIMAL(12,5),
    "finalGrade" DECIMAL(12,5),
    "feedback" TEXT,
    "overridden" BOOLEAN NOT NULL DEFAULT false,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "gradedById" UUID,
    "gradedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Grade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradeHistory" (
    "id" UUID NOT NULL,
    "gradeId" UUID NOT NULL,
    "finalGrade" DECIMAL(12,5),
    "feedback" TEXT,
    "source" TEXT NOT NULL,
    "changedById" UUID,
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GradeHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignSubmission" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 0,
    "status" "AssignSubmissionStatus" NOT NULL DEFAULT 'NEW',
    "onlineText" TEXT NOT NULL DEFAULT '',
    "latest" BOOLEAN NOT NULL DEFAULT true,
    "submittedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AssignSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignGrade" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 0,
    "grade" DECIMAL(12,5),
    "feedback" TEXT NOT NULL DEFAULT '',
    "graderId" UUID,
    "gradedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignGrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignOverride" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID,
    "groupId" UUID,
    "dueAt" TIMESTAMPTZ(3),
    "cutoffAt" TIMESTAMPTZ(3),
    "allowSubmissionsFrom" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizSlot" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "page" INTEGER NOT NULL DEFAULT 1,
    "slot" INTEGER NOT NULL,
    "kind" "QuizSlotKind" NOT NULL DEFAULT 'FIXED',
    "questionId" UUID,
    "categoryId" UUID,
    "includeSubcats" BOOLEAN NOT NULL DEFAULT false,
    "maxMark" DECIMAL(12,5) NOT NULL DEFAULT 1,

    CONSTRAINT "QuizSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizAttempt" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "state" "QuizAttemptState" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "sumGrades" DECIMAL(12,5),
    "needsManualGrading" BOOLEAN NOT NULL DEFAULT false,
    "preview" BOOLEAN NOT NULL DEFAULT false,
    "seed" INTEGER NOT NULL,

    CONSTRAINT "QuizAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionAttempt" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "page" INTEGER NOT NULL DEFAULT 1,
    "questionId" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "maxMark" DECIMAL(12,5) NOT NULL,
    "response" JSONB,
    "fraction" DECIMAL(12,7),
    "mark" DECIMAL(12,5),
    "needsGrading" BOOLEAN NOT NULL DEFAULT false,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "comment" TEXT NOT NULL DEFAULT '',
    "gradedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "QuestionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizOverride" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID,
    "openAt" TIMESTAMPTZ(3),
    "closeAt" TIMESTAMPTZ(3),
    "timeLimitSec" INTEGER,
    "attempts" INTEGER,

    CONSTRAINT "QuizOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionCategory" (
    "id" UUID NOT NULL,
    "contextId" UUID NOT NULL,
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "info" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "type" "QuestionType" NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "generalFeedback" TEXT NOT NULL DEFAULT '',
    "defaultMark" DECIMAL(12,5) NOT NULL DEFAULT 1,
    "penalty" DECIMAL(6,5) NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL,
    "status" "QuestionStatus" NOT NULL DEFAULT 'READY',
    "source" "QuestionSource" NOT NULL DEFAULT 'MANUAL',
    "tags" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "idNumber" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GradeLetter_contextId_lowerBound_key" ON "GradeLetter"("contextId", "lowerBound");

-- CreateIndex
CREATE INDEX "GradeCategory_courseId_idx" ON "GradeCategory"("courseId");

-- CreateIndex
CREATE INDEX "GradeItem_courseId_sortOrder_idx" ON "GradeItem"("courseId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "GradeItem_activityId_itemNumber_key" ON "GradeItem"("activityId", "itemNumber");

-- CreateIndex
CREATE INDEX "Grade_userId_idx" ON "Grade"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Grade_gradeItemId_userId_key" ON "Grade"("gradeItemId", "userId");

-- CreateIndex
CREATE INDEX "GradeHistory_gradeId_changedAt_idx" ON "GradeHistory"("gradeId", "changedAt");

-- CreateIndex
CREATE INDEX "AssignSubmission_activityId_latest_status_idx" ON "AssignSubmission"("activityId", "latest", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AssignSubmission_activityId_userId_attemptNumber_key" ON "AssignSubmission"("activityId", "userId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AssignGrade_activityId_userId_attemptNumber_key" ON "AssignGrade"("activityId", "userId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AssignOverride_activityId_userId_key" ON "AssignOverride"("activityId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "QuizSlot_activityId_slot_key" ON "QuizSlot"("activityId", "slot");

-- CreateIndex
CREATE INDEX "QuizAttempt_state_dueAt_idx" ON "QuizAttempt"("state", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuizAttempt_activityId_userId_attemptNumber_preview_key" ON "QuizAttempt"("activityId", "userId", "attemptNumber", "preview");

-- CreateIndex
CREATE INDEX "QuestionAttempt_questionId_idx" ON "QuestionAttempt"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionAttempt_attemptId_slot_key" ON "QuestionAttempt"("attemptId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "QuizOverride_activityId_userId_key" ON "QuizOverride"("activityId", "userId");

-- CreateIndex
CREATE INDEX "QuestionCategory_contextId_idx" ON "QuestionCategory"("contextId");

-- CreateIndex
CREATE INDEX "Question_categoryId_status_idx" ON "Question"("categoryId", "status");

-- AddForeignKey
ALTER TABLE "GradeCategory" ADD CONSTRAINT "GradeCategory_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeCategory" ADD CONSTRAINT "GradeCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "GradeCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeItem" ADD CONSTRAINT "GradeItem_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeItem" ADD CONSTRAINT "GradeItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "GradeCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeItem" ADD CONSTRAINT "GradeItem_scaleId_fkey" FOREIGN KEY ("scaleId") REFERENCES "Scale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeItem" ADD CONSTRAINT "GradeItem_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grade" ADD CONSTRAINT "Grade_gradeItemId_fkey" FOREIGN KEY ("gradeItemId") REFERENCES "GradeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grade" ADD CONSTRAINT "Grade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeHistory" ADD CONSTRAINT "GradeHistory_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "Grade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignSubmission" ADD CONSTRAINT "AssignSubmission_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignSubmission" ADD CONSTRAINT "AssignSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignGrade" ADD CONSTRAINT "AssignGrade_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignGrade" ADD CONSTRAINT "AssignGrade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignOverride" ADD CONSTRAINT "AssignOverride_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizSlot" ADD CONSTRAINT "QuizSlot_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizSlot" ADD CONSTRAINT "QuizSlot_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizSlot" ADD CONSTRAINT "QuizSlot_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "QuestionCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionAttempt" ADD CONSTRAINT "QuestionAttempt_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "QuizAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionAttempt" ADD CONSTRAINT "QuestionAttempt_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizOverride" ADD CONSTRAINT "QuizOverride_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionCategory" ADD CONSTRAINT "QuestionCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "QuestionCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "QuestionCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
