-- CreateEnum
CREATE TYPE "LiveStatus" AS ENUM ('SCHEDULED', 'LIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "UploadSession" ADD COLUMN     "name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "received" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "LiveMeeting" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "meetingId" TEXT NOT NULL,
    "status" "LiveStatus" NOT NULL DEFAULT 'SCHEDULED',
    "startedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveAttendance" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "moderator" BOOLEAN NOT NULL DEFAULT false,
    "firstJoinAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "joins" INTEGER NOT NULL DEFAULT 1,
    "durationSec" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LiveAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveRecording" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "recordId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "durationSec" INTEGER,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveRecording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoAsset" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "sourceFileId" UUID,
    "status" "VideoStatus" NOT NULL DEFAULT 'UPLOADED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "durationSec" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "outputs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VideoAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoCaption" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "lang" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fileId" UUID NOT NULL,

    CONSTRAINT "VideoCaption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoProgress" (
    "activityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "intervals" JSONB NOT NULL DEFAULT '[]',
    "watchedSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VideoProgress_pkey" PRIMARY KEY ("activityId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveMeeting_activityId_key" ON "LiveMeeting"("activityId");

-- CreateIndex
CREATE UNIQUE INDEX "LiveMeeting_meetingId_key" ON "LiveMeeting"("meetingId");

-- CreateIndex
CREATE UNIQUE INDEX "LiveAttendance_activityId_userId_key" ON "LiveAttendance"("activityId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "LiveRecording_recordId_key" ON "LiveRecording"("recordId");

-- CreateIndex
CREATE INDEX "LiveRecording_activityId_idx" ON "LiveRecording"("activityId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoAsset_activityId_key" ON "VideoAsset"("activityId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoCaption_assetId_lang_key" ON "VideoCaption"("assetId", "lang");

-- AddForeignKey
ALTER TABLE "LiveMeeting" ADD CONSTRAINT "LiveMeeting_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveAttendance" ADD CONSTRAINT "LiveAttendance_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveAttendance" ADD CONSTRAINT "LiveAttendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRecording" ADD CONSTRAINT "LiveRecording_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoCaption" ADD CONSTRAINT "VideoCaption_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoProgress" ADD CONSTRAINT "VideoProgress_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoProgress" ADD CONSTRAINT "VideoProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
