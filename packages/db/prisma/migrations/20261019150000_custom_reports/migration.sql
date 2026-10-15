-- Custom reports (report builder) and the schedules that email them.

CREATE TYPE "ReportFrequency" AS ENUM ('DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY');

CREATE TABLE "CustomReport" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "columns" JSONB NOT NULL DEFAULT '[]',
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "filters" JSONB NOT NULL DEFAULT '[]',
    "sort" JSONB,
    "audiences" JSONB NOT NULL DEFAULT '{}',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CustomReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReportSchedule" (
    "id" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'xlsx',
    "frequency" "ReportFrequency" NOT NULL DEFAULT 'WEEKLY',
    "hour" INTEGER NOT NULL DEFAULT 8,
    "day" INTEGER NOT NULL DEFAULT 1,
    "toAudience" BOOLEAN NOT NULL DEFAULT false,
    "userIds" UUID[],
    "skipEmpty" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMPTZ(3) NOT NULL,
    "lastRunAt" TIMESTAMPTZ(3),
    "lastRows" INTEGER,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReportSchedule_enabled_nextRunAt_idx" ON "ReportSchedule"("enabled", "nextRunAt");

ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "CustomReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
