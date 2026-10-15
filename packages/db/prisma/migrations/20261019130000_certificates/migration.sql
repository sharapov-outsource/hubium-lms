-- Course certificates: PDF templates and the certificates issued from them.

CREATE TYPE "CertificateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

CREATE TABLE "Certificate" (
    "id" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "orientation" TEXT NOT NULL DEFAULT 'landscape',
    "backgroundFileId" UUID,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "onCompletion" BOOLEAN NOT NULL DEFAULT true,
    "status" "CertificateStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CertificateIssue" (
    "id" UUID NOT NULL,
    "certificateId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,
    "issuedById" UUID,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" TEXT,

    CONSTRAINT "CertificateIssue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Certificate_courseId_idx" ON "Certificate"("courseId");

CREATE UNIQUE INDEX "CertificateIssue_code_key" ON "CertificateIssue"("code");

CREATE INDEX "CertificateIssue_userId_idx" ON "CertificateIssue"("userId");

CREATE UNIQUE INDEX "CertificateIssue_certificateId_userId_key" ON "CertificateIssue"("certificateId", "userId");

ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CertificateIssue" ADD CONSTRAINT "CertificateIssue_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "Certificate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CertificateIssue" ADD CONSTRAINT "CertificateIssue_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
