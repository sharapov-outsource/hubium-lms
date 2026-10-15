-- Activities given an expected completion date before it became an event (syncCalendar in
-- courses/activities.ts makes it from now on).
INSERT INTO "CalendarEvent" (id, scope, "courseId", "activityId", "moduleKey", kind, title,
                             "startsAt", "allDay", visible, "updatedAt")
SELECT gen_random_uuid(), 'COURSE', a."courseId", a.id, a."moduleKey", 'EXPECTED', a.name,
       a."completionExpectedAt", true, a.visibility = 'SHOWN' AND a."deletedAt" IS NULL, now()
  FROM "Activity" a
 WHERE a."completionExpectedAt" IS NOT NULL AND a."completionMode" <> 'NONE'
ON CONFLICT ("activityId", kind) DO NOTHING;
