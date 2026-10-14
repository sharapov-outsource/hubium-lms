-- Calculated questions (as Moodle's calculated, calculated simple and calculated
-- multichoice) and the datasets their categories share.
ALTER TYPE "QuestionType" ADD VALUE 'CALCULATED';
ALTER TYPE "QuestionType" ADD VALUE 'CALCULATEDSIMPLE';
ALTER TYPE "QuestionType" ADD VALUE 'CALCULATEDMULTI';

CREATE TYPE "DatasetDistribution" AS ENUM ('UNIFORM', 'LOGUNIFORM');

CREATE TABLE "QuestionDataset" (
    "id" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "min" DOUBLE PRECISION NOT NULL,
    "max" DOUBLE PRECISION NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 1,
    "distribution" "DatasetDistribution" NOT NULL DEFAULT 'UNIFORM',
    "items" DOUBLE PRECISION[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "QuestionDataset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QuestionDataset_categoryId_name_key" ON "QuestionDataset"("categoryId", "name");
ALTER TABLE "QuestionDataset" ADD CONSTRAINT "QuestionDataset_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "QuestionCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
