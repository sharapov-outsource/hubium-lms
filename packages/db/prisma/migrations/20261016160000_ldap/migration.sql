-- Sign-in through an LDAP directory.

CREATE TABLE "LdapServer" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "url" TEXT NOT NULL,
    "startTls" BOOLEAN NOT NULL DEFAULT false,
    "caCertificate" TEXT,
    "bindDn" TEXT NOT NULL DEFAULT '',
    "bindPasswordEnc" TEXT,
    "baseDn" TEXT NOT NULL,
    "userFilter" TEXT NOT NULL DEFAULT '(&(objectClass=person)(uid={login}))',
    "loginAttribute" TEXT NOT NULL DEFAULT 'uid',
    "idAttribute" TEXT NOT NULL DEFAULT 'entryUUID',
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "autoCreate" BOOLEAN NOT NULL DEFAULT false,
    "linkByEmail" BOOLEAN NOT NULL DEFAULT true,
    "suspendMissing" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMPTZ(3),
    "lastSyncResult" JSONB,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LdapServer_pkey" PRIMARY KEY ("id")
);
