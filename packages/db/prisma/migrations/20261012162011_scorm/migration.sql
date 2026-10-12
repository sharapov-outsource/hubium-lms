-- CreateEnum
CREATE TYPE "ScormVersion" AS ENUM ('SCORM_12', 'SCORM_2004');

-- CreateEnum
CREATE TYPE "ScormPackageStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "ScormPackage" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "fileId" UUID,
    "version" "ScormVersion" NOT NULL DEFAULT 'SCORM_12',
    "title" TEXT NOT NULL DEFAULT '',
    "status" "ScormPackageStatus" NOT NULL DEFAULT 'PROCESSING',
    "error" TEXT,
    "files" JSONB NOT NULL DEFAULT '[]',
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ScormPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScormSco" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "masteryScore" DOUBLE PRECISION,

    CONSTRAINT "ScormSco_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScormAttempt" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "score" DOUBLE PRECISION,

    CONSTRAINT "ScormAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScormTrack" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "scoId" UUID NOT NULL,
    "cmi" JSONB NOT NULL DEFAULT '{}',
    "location" TEXT NOT NULL DEFAULT '',
    "suspendData" TEXT NOT NULL DEFAULT '',
    "exit" TEXT NOT NULL DEFAULT '',
    "completionStatus" TEXT NOT NULL DEFAULT 'not attempted',
    "successStatus" TEXT NOT NULL DEFAULT 'unknown',
    "scoreRaw" DOUBLE PRECISION,
    "scoreMin" DOUBLE PRECISION,
    "scoreMax" DOUBLE PRECISION,
    "scoreScaled" DOUBLE PRECISION,
    "totalTimeSec" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ScormTrack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScormPackage_activityId_key" ON "ScormPackage"("activityId");

-- CreateIndex
CREATE UNIQUE INDEX "ScormSco_packageId_identifier_key" ON "ScormSco"("packageId", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX "ScormAttempt_activityId_userId_attemptNumber_key" ON "ScormAttempt"("activityId", "userId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ScormTrack_attemptId_scoId_key" ON "ScormTrack"("attemptId", "scoId");

-- AddForeignKey
ALTER TABLE "ScormPackage" ADD CONSTRAINT "ScormPackage_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScormSco" ADD CONSTRAINT "ScormSco_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ScormPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScormAttempt" ADD CONSTRAINT "ScormAttempt_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScormAttempt" ADD CONSTRAINT "ScormAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScormTrack" ADD CONSTRAINT "ScormTrack_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ScormAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScormTrack" ADD CONSTRAINT "ScormTrack_scoId_fkey" FOREIGN KEY ("scoId") REFERENCES "ScormSco"("id") ON DELETE CASCADE ON UPDATE CASCADE;
