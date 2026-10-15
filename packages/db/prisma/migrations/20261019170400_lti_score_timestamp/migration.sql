-- CreateTable
CREATE TABLE "LtiScore" (
    "activityId" UUID NOT NULL,
    "itemNumber" INTEGER NOT NULL,
    "userId" UUID NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LtiScore_pkey" PRIMARY KEY ("activityId","itemNumber","userId")
);

-- CreateIndex
CREATE INDEX "LtiScore_userId_idx" ON "LtiScore"("userId");

-- AddForeignKey
ALTER TABLE "LtiScore" ADD CONSTRAINT "LtiScore_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LtiScore" ADD CONSTRAINT "LtiScore_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
