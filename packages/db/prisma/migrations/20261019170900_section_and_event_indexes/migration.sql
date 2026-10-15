-- A section's activities in order, without walking every activity of the site.
CREATE INDEX "Activity_sectionId_rank_idx" ON "Activity"("sectionId", "rank");

-- What happened to a person, by kind (LDAP sync asks for each account's last one).
CREATE INDEX "EventLog_relatedUserId_name_createdAt_idx" ON "EventLog"("relatedUserId", "name", "createdAt");
