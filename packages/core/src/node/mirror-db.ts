import type pg from 'pg';

// What a node's copy of the files should hold, read from its replica (A): the blobs of the
// files of its categories (all of them without categories) and the unpacked content of the
// activities there (SCORM, H5P, video), the courses opened most recently first.

const IN_SCOPE = `(cardinality($1::uuid[]) = 0 OR c.level = 'SYSTEM' OR c.id = ANY($1::uuid[])
                   OR c."ancestorIds" && $1::uuid[])`;

/** When someone last opened the course the context is (in). */
const RECENT = `(SELECT max(a."lastAccessAt") FROM "CourseAccess" a
                  WHERE a."courseId" = c.id OR a."courseId" = ANY(c."ancestorIds"))`;

export interface MirrorBlob {
  key: string;
  size: number;
}

/** Blob keys the node should hold, those of recently opened courses first. */
export async function mirrorBlobs(a: pg.Pool, categoryIds: string[]): Promise<MirrorBlob[]> {
  const { rows } = await a.query<{ key: string; size: string }>(
    `SELECT b."storageKey" AS key, b.size::text AS size, max(${RECENT}) AS recent
       FROM "FileBlob" b
       JOIN "File" f ON f."blobId" = b.id
       JOIN "Context" c ON c.id = f."contextId"
      WHERE ${IN_SCOPE}
      GROUP BY b.id
      ORDER BY recent DESC NULLS LAST, b."createdAt" DESC`,
    [categoryIds],
  );
  return rows.map((r) => ({ key: r.key, size: Number(r.size) }));
}

/** Every blob key there is: a file the cloud no longer has goes from the node too. */
export async function allBlobKeys(a: pg.Pool): Promise<Set<string>> {
  const { rows } = await a.query<{ key: string }>('SELECT "storageKey" AS key FROM "FileBlob"');
  return new Set(rows.map((r) => r.key));
}

/** Storage prefixes of the unpacked content of the activities in scope. */
export async function mirrorModulePrefixes(a: pg.Pool, categoryIds: string[]): Promise<string[]> {
  const { rows } = await a.query<{ prefix: string }>(
    `SELECT prefix FROM (
       SELECT 'mod/scorm/' || p.id || '/' AS prefix, ${RECENT} AS recent
         FROM "ScormPackage" p JOIN "Context" c ON c.id = p."activityId" WHERE ${IN_SCOPE}
       UNION ALL
       SELECT 'mod/h5p/' || p.id || '/', ${RECENT}
         FROM "H5pPackage" p JOIN "Context" c ON c.id = p."activityId" WHERE ${IN_SCOPE}
       UNION ALL
       SELECT 'mod/video/' || v.id || '/', ${RECENT}
         FROM "VideoAsset" v JOIN "Context" c ON c.id = v."activityId" WHERE ${IN_SCOPE}
     ) x ORDER BY recent DESC NULLS LAST`,
    [categoryIds],
  );
  return rows.map((r) => r.prefix);
}
