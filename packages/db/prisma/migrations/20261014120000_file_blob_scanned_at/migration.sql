-- When the content passed a virus scan (ClamAV); null when stored without one.
ALTER TABLE "FileBlob" ADD COLUMN "scannedAt" TIMESTAMPTZ(3);
