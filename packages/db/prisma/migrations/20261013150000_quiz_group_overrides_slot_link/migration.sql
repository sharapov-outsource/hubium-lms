
-- AlterTable
ALTER TABLE "QuestionAttempt" ADD COLUMN     "quizSlotId" UUID;

-- AlterTable
ALTER TABLE "QuizOverride" ADD COLUMN     "groupId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "QuizOverride_activityId_groupId_key" ON "QuizOverride"("activityId", "groupId");

-- AddForeignKey
ALTER TABLE "QuestionAttempt" ADD CONSTRAINT "QuestionAttempt_quizSlotId_fkey" FOREIGN KEY ("quizSlotId") REFERENCES "QuizSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizOverride" ADD CONSTRAINT "QuizOverride_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing attempts: questions from fixed slots find their slot again (random ones cannot).
UPDATE "QuestionAttempt" qa SET "quizSlotId" = s.id
  FROM "QuizAttempt" a, "QuizSlot" s
 WHERE qa."attemptId" = a.id AND s."activityId" = a."activityId"
   AND s."kind" = 'FIXED' AND s."questionId" = qa."questionId" AND qa."quizSlotId" IS NULL;
