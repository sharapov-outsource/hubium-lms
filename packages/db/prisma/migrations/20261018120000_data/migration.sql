-- mod-data: fields of a database, its entries, their values and ratings.

CREATE TABLE "DataField" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "DataField_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DataRecord" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "userId" UUID,
    "groupId" UUID,
    "approved" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DataRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DataContent" (
    "id" UUID NOT NULL,
    "recordId" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "DataContent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DataRating" (
    "id" UUID NOT NULL,
    "recordId" UUID NOT NULL,
    "raterId" UUID NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DataRating_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DataField_activityId_sortOrder_idx" ON "DataField"("activityId", "sortOrder");
CREATE UNIQUE INDEX "DataField_activityId_name_key" ON "DataField"("activityId", "name");
CREATE INDEX "DataRecord_activityId_createdAt_idx" ON "DataRecord"("activityId", "createdAt");
CREATE INDEX "DataRecord_userId_idx" ON "DataRecord"("userId");
CREATE INDEX "DataContent_fieldId_idx" ON "DataContent"("fieldId");
CREATE UNIQUE INDEX "DataContent_recordId_fieldId_key" ON "DataContent"("recordId", "fieldId");
CREATE INDEX "DataRating_raterId_idx" ON "DataRating"("raterId");
CREATE UNIQUE INDEX "DataRating_recordId_raterId_key" ON "DataRating"("recordId", "raterId");

ALTER TABLE "DataField" ADD CONSTRAINT "DataField_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DataRecord" ADD CONSTRAINT "DataRecord_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DataRecord" ADD CONSTRAINT "DataRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DataContent" ADD CONSTRAINT "DataContent_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "DataRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DataContent" ADD CONSTRAINT "DataContent_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "DataField"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DataRating" ADD CONSTRAINT "DataRating_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "DataRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DataRating" ADD CONSTRAINT "DataRating_raterId_fkey" FOREIGN KEY ("raterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
