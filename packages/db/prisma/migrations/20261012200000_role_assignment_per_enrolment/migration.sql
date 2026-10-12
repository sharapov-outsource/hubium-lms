-- A user may hold the same course role through several enrolments (manual, self, cohort).
DROP INDEX "RoleAssignment_userId_roleId_contextId_component_key";

CREATE INDEX "RoleAssignment_userId_contextId_idx" ON "RoleAssignment"("userId", "contextId");

CREATE UNIQUE INDEX "RoleAssignment_enrolmentId_roleId_key" ON "RoleAssignment"("enrolmentId", "roleId");
