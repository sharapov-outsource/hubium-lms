-- mod-choice: answers to a choice.

CREATE TABLE "ChoiceAnswer" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "optionId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChoiceAnswer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChoiceAnswer_activityId_userId_optionId_key" ON "ChoiceAnswer"("activityId", "userId", "optionId");
CREATE INDEX "ChoiceAnswer_activityId_optionId_idx" ON "ChoiceAnswer"("activityId", "optionId");
CREATE INDEX "ChoiceAnswer_userId_idx" ON "ChoiceAnswer"("userId");

ALTER TABLE "ChoiceAnswer" ADD CONSTRAINT "ChoiceAnswer_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChoiceAnswer" ADD CONSTRAINT "ChoiceAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
