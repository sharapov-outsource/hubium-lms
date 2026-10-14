-- Question behaviours (deferred, immediate, interactive): hints, the behaviour of an
-- attempt, and the steps of each question in it, which are replayed to grade it.
CREATE TYPE "QuestionStepKind" AS ENUM ('SAVE', 'CHECK', 'TRYAGAIN', 'FINISH', 'MANUALGRADE');
CREATE TYPE "QuestionAttemptState" AS ENUM ('TODO', 'TRYAGAIN', 'COMPLETE');

ALTER TABLE "Question" ADD COLUMN "hints" JSONB NOT NULL DEFAULT '[]';
-- a third of the mark per wrong try, as Moodle: new questions however they are made
ALTER TABLE "Question" ALTER COLUMN "penalty" SET DEFAULT 0.33333;
ALTER TABLE "QuizAttempt" ADD COLUMN "behaviour" TEXT NOT NULL DEFAULT 'deferred';
ALTER TABLE "QuestionAttempt"
  ADD COLUMN "tries" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "state" "QuestionAttemptState" NOT NULL DEFAULT 'TODO';

CREATE TABLE "QuestionAttemptStep" (
    "id" UUID NOT NULL,
    "questionAttemptId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "QuestionStepKind" NOT NULL,
    "response" JSONB,
    "fraction" DECIMAL(12,7),
    "userId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionAttemptStep_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QuestionAttemptStep_questionAttemptId_seq_key"
  ON "QuestionAttemptStep"("questionAttemptId", "seq");
ALTER TABLE "QuestionAttemptStep" ADD CONSTRAINT "QuestionAttemptStep_questionAttemptId_fkey"
  FOREIGN KEY ("questionAttemptId") REFERENCES "QuestionAttempt"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The steps of earlier attempts, so they replay to the grades they have: the saved answer,
-- the end of a finished attempt, and a teacher's mark.
INSERT INTO "QuestionAttemptStep" ("id", "questionAttemptId", "seq", "kind", "response", "createdAt")
SELECT gen_random_uuid(), qa."id", 1, 'SAVE', qa."response", qa."updatedAt"
FROM "QuestionAttempt" qa
WHERE qa."response" IS NOT NULL;

INSERT INTO "QuestionAttemptStep" ("id", "questionAttemptId", "seq", "kind", "fraction", "createdAt")
SELECT gen_random_uuid(), qa."id", 2, 'FINISH', qa."fraction", COALESCE(a."finishedAt", qa."updatedAt")
FROM "QuestionAttempt" qa
JOIN "QuizAttempt" a ON a."id" = qa."attemptId"
WHERE a."state" IN ('FINISHED', 'ABANDONED');

INSERT INTO "QuestionAttemptStep" ("id", "questionAttemptId", "seq", "kind", "fraction", "userId", "createdAt")
SELECT gen_random_uuid(), qa."id", 3, 'MANUALGRADE',
       CASE WHEN qa."maxMark" > 0 THEN qa."mark" / qa."maxMark" ELSE 0 END,
       qa."gradedById", qa."updatedAt"
FROM "QuestionAttempt" qa
WHERE qa."gradedById" IS NOT NULL;

UPDATE "QuestionAttempt" qa SET "state" = 'COMPLETE'
FROM "QuizAttempt" a
WHERE a."id" = qa."attemptId" AND a."state" IN ('FINISHED', 'ABANDONED');
