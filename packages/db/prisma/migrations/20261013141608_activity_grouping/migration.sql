-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_groupingId_fkey" FOREIGN KEY ("groupingId") REFERENCES "Grouping"("id") ON DELETE SET NULL ON UPDATE CASCADE;
