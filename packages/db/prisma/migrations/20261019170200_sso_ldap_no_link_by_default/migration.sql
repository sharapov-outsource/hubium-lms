-- AlterTable
ALTER TABLE "LdapServer" ALTER COLUMN "linkByEmail" SET DEFAULT false;

-- AlterTable
ALTER TABLE "SsoProvider" ALTER COLUMN "linkByEmail" SET DEFAULT false;
