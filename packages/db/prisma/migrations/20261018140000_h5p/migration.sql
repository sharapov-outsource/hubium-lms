-- mod-h5p: H5P packages and learners' results from xAPI.

CREATE TYPE "H5pPackageStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

CREATE TABLE "H5pPackage" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "fileId" UUID,
    "status" "H5pPackageStatus" NOT NULL DEFAULT 'PROCESSING',
    "error" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "mainLibrary" TEXT NOT NULL DEFAULT '',
    "files" JSONB NOT NULL DEFAULT '[]',
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "H5pPackage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "H5pAttempt" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "rawScore" DOUBLE PRECISION,
    "maxScore" DOUBLE PRECISION,
    "scaled" DOUBLE PRECISION,
    "completion" BOOLEAN NOT NULL DEFAULT false,
    "success" BOOLEAN,
    "durationSec" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "H5pAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "H5pPackage_activityId_key" ON "H5pPackage"("activityId");
CREATE UNIQUE INDEX "H5pAttempt_activityId_userId_attemptNumber_key" ON "H5pAttempt"("activityId", "userId", "attemptNumber");

ALTER TABLE "H5pPackage" ADD CONSTRAINT "H5pPackage_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "H5pAttempt" ADD CONSTRAINT "H5pAttempt_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "H5pAttempt" ADD CONSTRAINT "H5pAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
