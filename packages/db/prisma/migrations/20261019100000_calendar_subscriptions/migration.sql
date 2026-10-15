-- Calendar imports and subscriptions: feeds by URL refreshed on a schedule, files imported
-- once; their events keep the UID they have there. Events get a location.

CREATE TABLE "CalendarSubscription" (
    "id" UUID NOT NULL,
    "scope" "CalendarScope" NOT NULL,
    "courseId" UUID,
    "userId" UUID,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "pollSeconds" INTEGER NOT NULL DEFAULT 86400,
    "lastSyncAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CalendarSubscription_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CalendarEvent" ADD COLUMN "location" TEXT NOT NULL DEFAULT '',
ADD COLUMN "subscriptionId" UUID,
ADD COLUMN "uid" TEXT;

CREATE INDEX "CalendarSubscription_courseId_idx" ON "CalendarSubscription"("courseId");
CREATE INDEX "CalendarSubscription_userId_idx" ON "CalendarSubscription"("userId");
CREATE UNIQUE INDEX "CalendarEvent_subscriptionId_uid_key" ON "CalendarEvent"("subscriptionId", "uid");

ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "CalendarSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarSubscription" ADD CONSTRAINT "CalendarSubscription_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarSubscription" ADD CONSTRAINT "CalendarSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
