-- CreateEnum
CREATE TYPE "NodeMode" AS ENUM ('NEW', 'ONLINE', 'READONLY', 'OFFLINE', 'SYNC', 'PASSTHROUGH');

-- CreateEnum
CREATE TYPE "NodeOpStatus" AS ENUM ('PENDING', 'APPLIED', 'CONFLICT', 'REJECTED');

-- CreateEnum
CREATE TYPE "NodeConflictStatus" AS ENUM ('OPEN', 'ACCEPTED', 'DISMISSED');

-- AlterTable
ALTER TABLE "EventLog" ADD COLUMN     "nodeId" UUID;

-- CreateTable
CREATE TABLE "Node" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "registrationHash" TEXT,
    "registrationExpiresAt" TIMESTAMPTZ(3),
    "tokenHash" TEXT,
    "dbRole" TEXT NOT NULL,
    "categoryIds" UUID[],
    "mode" "NodeMode" NOT NULL DEFAULT 'NEW',
    "version" TEXT,
    "status" JSONB NOT NULL DEFAULT '{}',
    "lastSeenAt" TIMESTAMPTZ(3),
    "replayingAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeAdmin" (
    "nodeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeAdmin_pkey" PRIMARY KEY ("nodeId","userId")
);

-- CreateTable
CREATE TABLE "NodeOutage" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "applied" INTEGER NOT NULL DEFAULT 0,
    "conflicts" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMPTZ(3),

    CONSTRAINT "NodeOutage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeOp" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "activityId" UUID,
    "actor" JSONB NOT NULL,
    "input" JSONB NOT NULL,
    "ip" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "seed" TEXT NOT NULL,
    "ids" JSONB NOT NULL DEFAULT '{}',
    "guards" JSONB NOT NULL DEFAULT '[]',
    "files" TEXT[],
    "uploads" JSONB NOT NULL DEFAULT '{}',
    "status" "NodeOpStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,

    CONSTRAINT "NodeOp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeOpResult" (
    "opId" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "status" "NodeOpStatus" NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeOpResult_pkey" PRIMARY KEY ("opId")
);

-- CreateTable
CREATE TABLE "NodeConflict" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "opId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "actorId" UUID,
    "courseId" UUID,
    "activityId" UUID,
    "op" JSONB NOT NULL,
    "reason" JSONB NOT NULL,
    "status" "NodeConflictStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeConflict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Node_registrationHash_key" ON "Node"("registrationHash");

-- CreateIndex
CREATE UNIQUE INDEX "Node_tokenHash_key" ON "Node"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Node_dbRole_key" ON "Node"("dbRole");

-- CreateIndex
CREATE INDEX "NodeAdmin_userId_idx" ON "NodeAdmin"("userId");

-- CreateIndex
CREATE INDEX "NodeOutage_nodeId_startedAt_idx" ON "NodeOutage"("nodeId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NodeOp_seq_key" ON "NodeOp"("seq");

-- CreateIndex
CREATE INDEX "NodeOpResult_nodeId_createdAt_idx" ON "NodeOpResult"("nodeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NodeConflict_opId_key" ON "NodeConflict"("opId");

-- CreateIndex
CREATE INDEX "NodeConflict_status_courseId_idx" ON "NodeConflict"("status", "courseId");

-- CreateIndex
CREATE INDEX "NodeConflict_actorId_idx" ON "NodeConflict"("actorId");

-- CreateIndex
CREATE INDEX "NodeConflict_nodeId_createdAt_idx" ON "NodeConflict"("nodeId", "createdAt");

-- AddForeignKey
ALTER TABLE "NodeAdmin" ADD CONSTRAINT "NodeAdmin_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeAdmin" ADD CONSTRAINT "NodeAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeOutage" ADD CONSTRAINT "NodeOutage_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeOpResult" ADD CONSTRAINT "NodeOpResult_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeConflict" ADD CONSTRAINT "NodeConflict_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
