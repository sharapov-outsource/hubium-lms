-- Events of activities and groups deleted before these keys existed go first: nothing
-- deleted them, and they named activities and groups no longer there.
DELETE FROM "CalendarEvent" e
 WHERE (e."activityId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Activity" a WHERE a.id = e."activityId"))
    OR (e."groupId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Group" g WHERE g.id = e."groupId"));

-- CreateIndex
CREATE INDEX "CalendarEvent_groupId_idx" ON "CalendarEvent"("groupId");

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
