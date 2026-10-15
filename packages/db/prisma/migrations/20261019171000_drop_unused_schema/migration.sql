-- Tables and columns nothing reads or writes: tags of the first design (questions keep
-- theirs in an array), image variants never made, file licence and author, an S3 multipart
-- id and a pg-boss job id never stored.
DROP TABLE "TagInstance";
DROP TABLE "Tag";
DROP TABLE "FileVariant";
ALTER TABLE "File" DROP COLUMN "license", DROP COLUMN "author";
ALTER TABLE "UploadSession" DROP COLUMN "multipartUploadId";
ALTER TABLE "BackgroundTask" DROP COLUMN "pgBossJobId";
