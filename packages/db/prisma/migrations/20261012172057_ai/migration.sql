-- pgvector for retrieval embeddings (bundled in the pgvector/pgvector image).
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "AiProviderKind" AS ENUM ('ANTHROPIC', 'OPENAI_COMPAT', 'MOCK');

-- CreateEnum
CREATE TYPE "AiFeature" AS ENUM ('QUIZGEN', 'GRADING_ASSIST', 'TUTOR');

-- CreateEnum
CREATE TYPE "AiUsageStatus" AS ENUM ('OK', 'ERROR', 'REFUSED', 'LIMITED');

-- CreateEnum
CREATE TYPE "AiJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "GradingSuggestionStatus" AS ENUM ('PENDING', 'APPLIED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "TutorRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateTable
CREATE TABLE "AiProvider" (
    "id" UUID NOT NULL,
    "kind" "AiProviderKind" NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKeyEnc" TEXT,
    "models" JSONB NOT NULL,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiEmbeddingConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "kind" "AiProviderKind" NOT NULL,
    "baseUrl" TEXT,
    "model" TEXT NOT NULL,
    "dims" INTEGER NOT NULL DEFAULT 1024,
    "apiKeyEnc" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiEmbeddingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiFeatureConfig" (
    "feature" "AiFeature" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "providerId" UUID,
    "model" TEXT NOT NULL DEFAULT 'generation',
    "effort" TEXT,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "noticeVersion" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiFeatureConfig_pkey" PRIMARY KEY ("feature")
);

-- CreateTable
CREATE TABLE "AiCourseFeature" (
    "courseId" UUID NOT NULL,
    "feature" "AiFeature" NOT NULL,
    "enabled" BOOLEAN NOT NULL,

    CONSTRAINT "AiCourseFeature_pkey" PRIMARY KEY ("courseId","feature")
);

-- CreateTable
CREATE TABLE "AiConsent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "feature" "AiFeature" NOT NULL,
    "noticeVersion" INTEGER NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" UUID NOT NULL,
    "feature" "AiFeature" NOT NULL,
    "userId" UUID,
    "courseId" UUID,
    "providerId" UUID,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "status" "AiUsageStatus" NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentChunk" (
    "id" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "activityId" UUID,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "embedding" vector(1024),
    "tsv" tsvector,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiGeneration" (
    "id" UUID NOT NULL,
    "feature" "AiFeature" NOT NULL,
    "courseId" UUID NOT NULL,
    "activityId" UUID,
    "requestedById" UUID NOT NULL,
    "status" "AiJobStatus" NOT NULL DEFAULT 'QUEUED',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradingSuggestion" (
    "id" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "suggestedGrade" DECIMAL(12,5),
    "breakdown" JSONB NOT NULL,
    "feedbackDraft" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "model" TEXT NOT NULL,
    "status" "GradingSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GradingSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TutorConversation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TutorConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TutorMessage" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "role" "TutorRole" NOT NULL,
    "content" TEXT NOT NULL,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "usageId" UUID,
    "rating" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TutorMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiConsent_userId_feature_noticeVersion_key" ON "AiConsent"("userId", "feature", "noticeVersion");

-- CreateIndex
CREATE INDEX "AiUsage_userId_createdAt_idx" ON "AiUsage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsage_courseId_createdAt_idx" ON "AiUsage"("courseId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsage_createdAt_idx" ON "AiUsage"("createdAt");

-- CreateIndex
CREATE INDEX "ContentChunk_courseId_idx" ON "ContentChunk"("courseId");

-- CreateIndex
CREATE INDEX "ContentChunk_activityId_idx" ON "ContentChunk"("activityId");

-- CreateIndex
CREATE INDEX "ContentChunk_tsv_idx" ON "ContentChunk" USING GIN ("tsv");

-- CreateIndex
CREATE UNIQUE INDEX "ContentChunk_sourceType_sourceId_chunkIndex_key" ON "ContentChunk"("sourceType", "sourceId", "chunkIndex");

-- CreateIndex
CREATE INDEX "AiGeneration_courseId_createdAt_idx" ON "AiGeneration"("courseId", "createdAt");

-- CreateIndex
CREATE INDEX "GradingSuggestion_submissionId_createdAt_idx" ON "GradingSuggestion"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "TutorConversation_userId_courseId_updatedAt_idx" ON "TutorConversation"("userId", "courseId", "updatedAt");

-- CreateIndex
CREATE INDEX "TutorMessage_conversationId_createdAt_idx" ON "TutorMessage"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiFeatureConfig" ADD CONSTRAINT "AiFeatureConfig_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AiProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCourseFeature" ADD CONSTRAINT "AiCourseFeature_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConsent" ADD CONSTRAINT "AiConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentChunk" ADD CONSTRAINT "ContentChunk_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentChunk" ADD CONSTRAINT "ContentChunk_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiGeneration" ADD CONSTRAINT "AiGeneration_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradingSuggestion" ADD CONSTRAINT "GradingSuggestion_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorConversation" ADD CONSTRAINT "TutorConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorConversation" ADD CONSTRAINT "TutorConversation_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorMessage" ADD CONSTRAINT "TutorMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "TutorConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Approximate nearest-neighbour index for cosine similarity (not expressible in the Prisma schema).
CREATE INDEX "ContentChunk_embedding_hnsw_idx" ON "ContentChunk" USING hnsw ("embedding" vector_cosine_ops);
