-- CreateTable
CREATE TABLE "FileBlobText" (
    "blobId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileBlobText_pkey" PRIMARY KEY ("blobId")
);

-- AddForeignKey
ALTER TABLE "FileBlobText" ADD CONSTRAINT "FileBlobText_blobId_fkey" FOREIGN KEY ("blobId") REFERENCES "FileBlob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
