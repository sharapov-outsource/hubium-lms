-- Badges (Open Badges 2.0): badge classes of the site or a course, awards, and awards given by hand.

CREATE TYPE "BadgeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

CREATE TABLE "Badge" (
    "id" UUID NOT NULL,
    "courseId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "imageFileId" UUID,
    "criteria" JSONB NOT NULL DEFAULT '{}',
    "expiresAfterDays" INTEGER,
    "expiresAt" TIMESTAMPTZ(3),
    "status" "BadgeStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BadgeAward" (
    "id" UUID NOT NULL,
    "badgeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3),
    "recipientType" TEXT NOT NULL,
    "recipientIdentity" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "awardedById" UUID,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" TEXT,

    CONSTRAINT "BadgeAward_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BadgeMark" (
    "badgeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "markedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BadgeMark_pkey" PRIMARY KEY ("badgeId","userId","roleId")
);

CREATE INDEX "Badge_courseId_idx" ON "Badge"("courseId");

CREATE INDEX "BadgeAward_userId_idx" ON "BadgeAward"("userId");

CREATE UNIQUE INDEX "BadgeAward_badgeId_userId_key" ON "BadgeAward"("badgeId", "userId");

ALTER TABLE "Badge" ADD CONSTRAINT "Badge_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BadgeAward" ADD CONSTRAINT "BadgeAward_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "Badge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BadgeAward" ADD CONSTRAINT "BadgeAward_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BadgeMark" ADD CONSTRAINT "BadgeMark_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "Badge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BadgeMark" ADD CONSTRAINT "BadgeMark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
