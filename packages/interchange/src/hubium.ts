import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  addSection,
  assertModuleEnabled,
  type BadgeCriteriaT,
  type BadgeRuleT,
  buildModuleCtx,
  CertificateFields,
  checkCriteria,
  compareRank,
  createCourse,
  disabledTypesIn,
  disabledTypesWarning,
  ensureCourseGradebook,
  ForbiddenError,
  foreignCourseValues,
  getModule,
  importActivity,
  listCourseFields,
  NotFoundError,
  parseInput,
  type RequestContext,
  rankBetween,
  syncGradeItemsFor,
  toActivityRef,
  ValidationError,
} from '@hubium/core';
import { purgeActivityRecord, purgeCourseRecord } from '@hubium/core/courses/recyclebin';
import { storeFile } from '@hubium/core/files/files';
import { getStorage } from '@hubium/core/files/storage';
import { type Db, type Prisma, uuidv7 } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { isLocale } from '@hubium/i18n';
import { parseSettings } from '@hubium/module-sdk';
import {
  Dataset,
  datasetFromRow,
  Hints,
  type QuestionType,
  questionDataSchemas,
  questionTypes,
} from '@hubium/questions';
import { strFromU8, strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { z } from 'zod';
import { type ArchiveLimits, unzipLimited } from './archive.ts';

// The .hubium course format: a zip with manifest.json, course.json, files.json and
// files/<blobId>. Restoring maps every id from the source course to a new one, so the
// same pipeline also copies courses and activities on this site, without an archive: the
// copy's files are new rows on the same stored content. Learners' data is not included.

export const FORMAT = 'hubium-course';
export const FORMAT_VERSION = 1;
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

const Manifest = z.object({
  format: z.literal(FORMAT),
  formatVersion: z.number().int().min(1).max(FORMAT_VERSION),
  appVersion: z.string(),
  createdAt: z.string(),
  userData: z.boolean(),
  modules: z.record(z.string(), z.number()),
});

const Section = z.object({
  id: z.string(),
  /** A subsection names its section (which comes before it); absent in older archives. */
  parentId: z.string().nullable().default(null),
  /** How many of its section's activities in the archive come before a subsection. */
  position: z.number().int().min(0).default(0),
  title: z.string(),
  summary: z.string(),
  visible: z.boolean(),
  availability: z.unknown().nullable(),
});

const ActivityRow = z.object({
  id: z.string(),
  sectionId: z.string(),
  moduleKey: z.string(),
  name: z.string(),
  intro: z.string(),
  showIntro: z.boolean(),
  visibility: z.enum(['SHOWN', 'HIDDEN', 'STEALTH']),
  availability: z.unknown().nullable(),
  completionMode: z.enum(['NONE', 'MANUAL', 'AUTO']),
  completionRules: z.record(z.string(), z.unknown()),
  completionExpectedAt: z.string().nullable(),
  groupMode: z.enum(['NONE', 'SEPARATE', 'VISIBLE']),
  groupingId: z.string().nullable().default(null),
  idNumber: z.string().nullable(),
  settings: z.record(z.string(), z.unknown()),
  module: z.unknown().optional(),
});

const Aggregation = z.enum(['NATURAL', 'MEAN', 'WEIGHTED_MEAN', 'HIGHEST', 'LOWEST', 'MEDIAN']);

/** Gradebook setup: category tree, course scales and letters, item settings (no grades). */
const GradebookJson = z.object({
  categories: z.array(
    z.object({
      id: z.string(),
      parentId: z.string().nullable(),
      name: z.string(),
      aggregation: Aggregation,
      dropLowest: z.number().int(),
      keepHighest: z.number().int(),
      aggregateOnlyGraded: z.boolean(),
      hidden: z.boolean(),
      weight: z.number(),
      sortOrder: z.number().int(),
      idNumber: z.string().nullable().default(null),
    }),
  ),
  scales: z.array(z.object({ id: z.string(), name: z.string(), items: z.array(z.string()) })),
  letters: z.array(z.object({ lowerBound: z.number(), letter: z.string() })),
  items: z.array(
    z.object({
      /** The item's id in the source course, which formulas refer to. */
      id: z.string().optional(),
      kind: z.enum(['MODULE', 'MANUAL']),
      activityId: z.string().nullable(),
      itemNumber: z.number().int(),
      name: z.string(),
      categoryId: z.string().nullable(),
      gradeType: z.enum(['VALUE', 'SCALE', 'TEXT', 'NONE']),
      scaleId: z.string().nullable(),
      gradeMin: z.number(),
      gradeMax: z.number(),
      gradePass: z.number().nullable(),
      weight: z.number(),
      decimals: z.number().int(),
      display: z.enum(['REAL', 'PERCENT', 'LETTER']),
      hidden: z.boolean(),
      locked: z.boolean(),
      sortOrder: z.number().int(),
      idNumber: z.string().nullable(),
      /** A calculated item's formula, references as ##gi<id>## / ##gc<id>## of the source. */
      calculation: z.string().max(2000).nullable().default(null),
    }),
  ),
});

const CourseJson = z.object({
  course: z.object({
    id: z.string(),
    fullName: z.string(),
    shortName: z.string(),
    summary: z.string(),
    format: z.enum(['TOPICS', 'WEEKS', 'SINGLE']),
    formatOptions: z.unknown(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    lang: z.string().nullable(),
    enableCompletion: z.boolean(),
    completionSettings: z.unknown(),
    groupMode: z.enum(['NONE', 'SEPARATE', 'VISIBLE']),
    groupModeForced: z.boolean(),
    settings: z.unknown(),
    /** Custom course fields by short name; absent in older archives. */
    customFields: z.record(z.string(), z.unknown()).default({}),
  }),
  sections: z.array(Section),
  activities: z.array(ActivityRow),
  /** Course badges, without their awards; absent in older archives. */
  badges: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        imageFileId: z.string().nullable(),
        criteria: z.unknown(),
        expiresAfterDays: z.number().int().nullable(),
        expiresAt: z.string().nullable(),
      }),
    )
    .default([]),
  /**
   * The course's competencies and those of its activities, named by framework and
   * competency ID numbers (they link up on a site that has them); absent in older archives.
   */
  competencies: z
    .object({
      pushRatings: z.boolean().default(true),
      course: z.array(
        z.object({ framework: z.string(), idNumber: z.string(), ruleOutcome: z.string() }),
      ),
      activities: z.array(
        z.object({
          activityId: z.string(),
          framework: z.string(),
          idNumber: z.string(),
          ruleOutcome: z.string(),
        }),
      ),
    })
    .optional(),
  /** Course certificates, without their issues; absent in older archives. */
  certificates: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        orientation: z.string(),
        backgroundFileId: z.string().nullable(),
        fields: z.unknown(),
        onCompletion: z.boolean(),
      }),
    )
    .default([]),
  groups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      idNumber: z.string().nullable(),
    }),
  ),
  groupings: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        groupIds: z.array(z.string()),
      }),
    )
    .default([]),
  /** Absent in archives made before the gradebook was backed up. */
  gradebook: GradebookJson.optional(),
  questionCategories: z.array(
    z.object({
      id: z.string(),
      parentId: z.string().nullable(),
      name: z.string(),
      info: z.string(),
      sortOrder: z.number(),
    }),
  ),
  /** Datasets the categories share (calculated questions); absent in older archives. */
  questionDatasets: z.array(z.object({ categoryId: z.string() }).and(Dataset)).default([]),
  questions: z.array(
    z.object({
      id: z.string(),
      categoryId: z.string(),
      type: z.string(),
      name: z.string(),
      text: z.string(),
      generalFeedback: z.string(),
      defaultMark: z.number(),
      penalty: z.number(),
      // absent from archives made before hints existed
      hints: Hints.catch([]),
      data: z.unknown(),
      status: z.enum(['DRAFT', 'READY', 'HIDDEN']).catch('READY'),
      tags: z.array(z.string()),
      idNumber: z.string().nullable(),
    }),
  ),
});

const FileRow = z.object({
  id: z.string(),
  contextId: z.string(),
  component: z.string(),
  area: z.string(),
  itemId: z.string(),
  path: z.string(),
  name: z.string(),
  mimeType: z.string(),
  blobId: z.string(),
});

export type CourseBackup = z.infer<typeof CourseJson>;

/** What a backup of a course holds, read from the database: all but the files' content. */
interface BackupParts {
  manifest: z.input<typeof Manifest>;
  course: z.input<typeof CourseJson>;
  files: z.input<typeof FileRow>[];
  /** The stored content the files name, once each. */
  blobs: { id: string; storageKey: string; size: number; mimeType: string }[];
}

/** A .hubium archive of a course in memory (structure, content, question bank, files). */
export async function exportCourse(ctx: RequestContext, courseId: string): Promise<Uint8Array> {
  await ctx.perm.require('backup:create', courseId);
  const chunks: Uint8Array[] = [];
  for await (const c of archiveChunks(await collectBackup(ctx, courseId, {}))) chunks.push(c);
  return Buffer.concat(chunks);
}

/** Writes a .hubium archive of a course to a file, a little at a time (a background task). */
export async function writeCourseArchive(
  ctx: RequestContext,
  courseId: string,
  path: string,
  /** Told after each file how many bytes of the files' content are in. */
  progress?: (done: number, total: number) => Promise<unknown>,
): Promise<void> {
  await ctx.perm.require('backup:create', courseId);
  const parts = await collectBackup(ctx, courseId, {});
  await pipeline(Readable.from(archiveChunks(parts, progress)), createWriteStream(path));
}

/** Content that is compressed already (pictures, media, archives, PDF, office files). */
const compressed = (mime: string) =>
  (/^(image|video|audio)\//.test(mime) && mime !== 'image/svg+xml') ||
  /^application\/(zip|gzip|x-gzip|pdf|x-7z-compressed|vnd\.rar|epub\+zip|vnd\.openxmlformats-|vnd\.oasis\.opendocument\.)/.test(
    mime,
  );

/**
 * The zip of a backup, chunk by chunk as it is written: each file is read from storage as it
 * goes in, so a course takes little memory whatever its size. Content that is compressed
 * already goes in as it is; compressing it again would cost time and gain nothing.
 */
async function* archiveChunks(
  parts: BackupParts,
  progress?: (done: number, total: number) => Promise<unknown>,
): AsyncGenerator<Uint8Array> {
  const total = parts.blobs.reduce((n, b) => n + b.size, 0);
  if (total > MAX_BACKUP_BYTES)
    throw new ValidationError({ course: ['The course is too large to back up'] });
  let done = 0;
  const out: Uint8Array[] = [];
  const state: { error?: Error } = {};
  const zip = new Zip((err, chunk) => {
    if (err) state.error = err;
    else out.push(chunk);
  });
  const settled = () => {
    if (state.error) throw state.error;
    return out.splice(0);
  };
  for (const [name, value] of [
    ['manifest.json', parts.manifest],
    ['course.json', parts.course],
    ['files.json', parts.files],
  ] as const) {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(strToU8(JSON.stringify(value)), true);
    yield* settled();
  }
  const storage = getStorage();
  for (const b of parts.blobs) {
    const name = `files/${b.id}`;
    const entry = compressed(b.mimeType)
      ? new ZipPassThrough(name)
      : new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    for await (const c of await storage.getStream(b.storageKey)) {
      entry.push(typeof c === 'string' ? strToU8(c) : (c as Uint8Array));
      yield* settled();
    }
    entry.push(new Uint8Array(0), true);
    yield* settled();
    done += b.size;
    await progress?.(done, total);
  }
  zip.end();
  yield* settled();
}

/**
 * A backup of a course on this site, taken without an archive: read through the archive's
 * schemas as a restore reads them, its files naming the content already stored.
 */
async function localBackup(
  ctx: RequestContext,
  courseId: string,
  opts: { activityIds?: string[] },
): Promise<Backup> {
  const parts = await collectBackup(ctx, courseId, opts);
  return {
    manifest: Manifest.parse(parts.manifest),
    course: CourseJson.parse(JSON.parse(JSON.stringify(parts.course))),
    files: z.array(FileRow).parse(parts.files),
    blob: () => undefined,
    local: true,
  };
}

async function collectBackup(
  ctx: RequestContext,
  courseId: string,
  opts: {
    /** Only these activities, and of the course's own files those they show (an import). */
    activityIds?: string[];
  },
): Promise<BackupParts> {
  const db = ctx.db;
  const course = await db.course.findUniqueOrThrow({ where: { id: courseId } });
  const allSections = await db.courseSection.findMany({
    where: { courseId },
    orderBy: { rank: 'asc' },
  });
  // each section of the course followed by its subsections
  const sections = allSections
    .filter((s) => !s.parentId)
    .flatMap((s) => [s, ...allSections.filter((x) => x.parentId === s.id)]);
  const activities = await db.activity.findMany({
    where: {
      courseId,
      deletedAt: null,
      ...(opts.activityIds ? { id: { in: opts.activityIds } } : {}),
    },
    orderBy: { rank: 'asc' },
  });
  const order = new Map(sections.map((s, i) => [s.id, i]));
  activities.sort(
    (a, b) => order.get(a.sectionId)! - order.get(b.sectionId)! || a.rank.localeCompare(b.rank),
  );
  const [groups, groupings, categories, gradeCategories, gradeItems, scales, letters] =
    await Promise.all([
      db.group.findMany({ where: { courseId } }),
      db.grouping.findMany({ where: { courseId }, include: { groups: true } }),
      db.questionCategory.findMany({ where: { contextId: courseId } }),
      db.gradeCategory.findMany({ where: { courseId } }),
      db.gradeItem.findMany({ where: { courseId, kind: { in: ['MODULE', 'MANUAL'] } } }),
      db.scale.findMany({ where: { courseId } }),
      db.gradeLetter.findMany({ where: { contextId: courseId } }),
    ]);
  const exported = new Set(activities.map((a) => a.id));
  const n = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());
  const questions = await db.question.findMany({
    where: { categoryId: { in: categories.map((c) => c.id) } },
  });
  const datasets = await db.questionDataset.findMany({
    where: { categoryId: { in: categories.map((c) => c.id) } },
  });

  const actRows: z.input<typeof ActivityRow>[] = [];
  for (const a of activities) {
    const m = getModule(a.moduleKey);
    let module: unknown;
    if (m?.backup?.export)
      module = await m.backup.export(buildModuleCtx(ctx), toActivityRef(a) as never);
    actRows.push({
      id: a.id,
      sectionId: a.sectionId,
      moduleKey: a.moduleKey,
      name: a.name,
      intro: a.intro,
      showIntro: a.showIntro,
      visibility: a.visibility,
      availability: a.availability ?? null,
      completionMode: a.completionMode,
      completionRules: (a.completionRules ?? {}) as Record<string, unknown>,
      completionExpectedAt: a.completionExpectedAt?.toISOString() ?? null,
      groupMode: a.groupMode,
      groupingId: a.groupingId,
      idNumber: a.idNumber,
      settings: (a.settings ?? {}) as Record<string, unknown>,
      module,
    });
  }

  const userAreas = new Map(
    activities.map((a) => [a.id, getModule(a.moduleKey)?.backup?.userFileAreas ?? []]),
  );
  const shown = opts.activityIds
    ? JSON.stringify([actRows, activities.some((a) => a.moduleKey === 'quiz') ? questions : []])
    : null;
  const files = (
    await db.file.findMany({
      where: { contextId: { in: [courseId, ...activities.map((a) => a.id)] } },
      include: { blob: true },
    })
  ).filter(
    (f) =>
      !(userAreas.get(f.contextId) ?? []).includes(f.area) &&
      (shown === null || f.contextId !== courseId || shown.includes(f.id)),
  );

  const blobs = new Map(
    files.map((f) => [
      f.blobId,
      {
        id: f.blobId,
        storageKey: f.blob.storageKey,
        size: Number(f.blob.size),
        mimeType: f.blob.mimeType,
      },
    ]),
  );
  const manifest: z.input<typeof Manifest> = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion: '1.0.0',
    createdAt: new Date().toISOString(),
    userData: false,
    modules: Object.fromEntries(
      [...new Set(activities.map((a) => a.moduleKey))].map((k) => [k, 1]),
    ),
  };
  const body: z.input<typeof CourseJson> = {
    course: {
      id: course.id,
      fullName: course.fullName,
      shortName: course.shortName,
      summary: course.summary,
      format: course.format,
      formatOptions: course.formatOptions,
      startDate: course.startDate?.toISOString() ?? null,
      endDate: course.endDate?.toISOString() ?? null,
      lang: course.lang,
      enableCompletion: course.enableCompletion,
      completionSettings: course.completionSettings,
      groupMode: course.groupMode,
      groupModeForced: course.groupModeForced,
      settings: course.settings,
      customFields: (course.customFields ?? {}) as Record<string, unknown>,
    },
    sections: sections.map((s) => ({
      id: s.id,
      parentId: s.parentId,
      position: s.parentId
        ? activities.filter((a) => a.sectionId === s.parentId && compareRank(a, s) < 0).length
        : 0,
      title: s.title,
      summary: s.summary,
      visible: s.visible,
      availability: s.availability ?? null,
    })),
    activities: actRows,
    badges: opts.activityIds
      ? []
      : (await db.badge.findMany({ where: { courseId } })).map((x) => ({
          id: x.id,
          name: x.name,
          description: x.description,
          imageFileId: x.imageFileId,
          criteria: x.criteria,
          expiresAfterDays: x.expiresAfterDays,
          expiresAt: x.expiresAt?.toISOString() ?? null,
        })),
    competencies: await exportCompetencies(
      db,
      courseId,
      activities.map((a) => a.id),
      !opts.activityIds,
    ),
    certificates: opts.activityIds
      ? []
      : (await db.certificate.findMany({ where: { courseId } })).map((x) => ({
          id: x.id,
          name: x.name,
          orientation: x.orientation,
          backgroundFileId: x.backgroundFileId,
          fields: x.fields,
          onCompletion: x.onCompletion,
        })),
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      idNumber: g.idNumber,
    })),
    groupings: groupings.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      groupIds: g.groups.map((x) => x.groupId),
    })),
    gradebook: {
      categories: gradeCategories.map((c) => ({
        id: c.id,
        parentId: c.parentId,
        name: c.name,
        aggregation: c.aggregation,
        dropLowest: c.dropLowest,
        keepHighest: c.keepHighest,
        aggregateOnlyGraded: c.aggregateOnlyGraded,
        hidden: c.hidden,
        weight: c.weight.toNumber(),
        sortOrder: c.sortOrder,
        idNumber: c.idNumber,
      })),
      scales: scales.map((x) => ({ id: x.id, name: x.name, items: x.items })),
      letters: letters.map((l) => ({ lowerBound: l.lowerBound.toNumber(), letter: l.letter })),
      items: gradeItems
        .filter((i) => i.kind === 'MANUAL' || (i.activityId && exported.has(i.activityId)))
        .map((i) => ({
          id: i.id,
          kind: i.kind as 'MODULE' | 'MANUAL',
          activityId: i.activityId,
          itemNumber: i.itemNumber,
          name: i.name,
          categoryId: i.categoryId,
          gradeType: i.gradeType,
          scaleId: i.scaleId,
          gradeMin: i.gradeMin.toNumber(),
          gradeMax: i.gradeMax.toNumber(),
          gradePass: n(i.gradePass),
          weight: i.weight.toNumber(),
          decimals: i.decimals,
          display: i.display,
          hidden: i.hidden,
          locked: i.locked,
          sortOrder: i.sortOrder,
          idNumber: i.idNumber,
          calculation: i.calculation,
        })),
    },
    questionCategories: categories.map((c) => ({
      id: c.id,
      parentId: c.parentId,
      name: c.name,
      info: c.info,
      sortOrder: c.sortOrder,
    })),
    questionDatasets: datasets.map((d) => ({ categoryId: d.categoryId, ...datasetFromRow(d) })),
    questions: questions.map((q) => ({
      id: q.id,
      categoryId: q.categoryId,
      type: q.type,
      name: q.name,
      text: q.text,
      generalFeedback: q.generalFeedback,
      defaultMark: Number(q.defaultMark),
      penalty: Number(q.penalty),
      hints: Hints.catch([]).parse(q.hints),
      data: q.data,
      status: q.status,
      tags: q.tags,
      idNumber: q.idNumber,
    })),
  };
  const fileRows: z.input<typeof FileRow>[] = files.map((f) => ({
    id: f.id,
    contextId: f.contextId,
    component: f.component,
    area: f.area,
    itemId: f.itemId,
    path: f.path,
    name: f.name,
    mimeType: f.mimeType,
    blobId: f.blobId,
  }));
  return { manifest, course: body, files: fileRows, blobs: [...blobs.values()] };
}

/** The short name of a course made from an archive: the one it had, or with -1, -2… when
 *  that is taken, cut to fit the 100 characters a short name may have (Moodle's run to 255). */
export async function freeShortName(db: RequestContext['db'], name: string): Promise<string> {
  const MAX = 100;
  const base = name.trim().slice(0, MAX) || 'IMPORT';
  let candidate = base;
  for (let i = 1; await db.course.findUnique({ where: { shortName: candidate } }); i++) {
    const suffix = `-${i}`;
    candidate = `${base.slice(0, MAX - suffix.length)}${suffix}`;
  }
  return candidate;
}

export interface RestoreReport {
  courseId: string;
  sections: number;
  activities: number;
  /** The activities made, in the archive's order. */
  activityIds: string[];
  questions: number;
  files: number;
  warnings: string[];
}

/** Replaces every mapped id inside a string (ids are UUIDs, so this is unambiguous). */
export function rewriteIds(text: string, map: Map<string, string>): string {
  if (!map.size || !text) return text;
  return text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    (m) => map.get(m.toLowerCase()) ?? m,
  );
}

const rewriteJson = <T>(v: T, map: Map<string, string>): T =>
  v === null || v === undefined ? v : (JSON.parse(rewriteIds(JSON.stringify(v), map)) as T);

/**
 * Drops the access conditions that name an activity, group or grouping an import left
 * behind (they would point into the other course); null when no condition stays.
 */
export function pruneAvailability(tree: unknown, map: Map<string, string>): unknown {
  if (!tree || typeof tree !== 'object' || !Array.isArray((tree as { c?: unknown }).c)) return tree;
  const t = tree as { c: unknown[] };
  const c = t.c.flatMap((x) => {
    if (x && typeof x === 'object' && 'c' in x) {
      const sub = pruneAvailability(x, map);
      return sub ? [sub] : [];
    }
    const cond = (x ?? {}) as Record<string, unknown>;
    const ref = cond.activityId ?? cond.groupingId ?? cond.groupId;
    return typeof ref === 'string' && !map.has(ref) ? [] : [x];
  });
  return c.length ? { ...t, c } : null;
}

/** A backup to restore: read from a .hubium archive, or taken on this site. */
interface Backup {
  manifest: z.infer<typeof Manifest>;
  course: CourseBackup;
  files: z.infer<typeof FileRow>[];
  /** A file's content in the archive. */
  blob(blobId: string): Uint8Array | undefined;
  /** Taken on this site: the copy's files are new rows on the content already stored. */
  local?: boolean;
}

/** Reads and validates a .hubium archive. */
export function readBackup(zip: Uint8Array, limits?: ArchiveLimits): Backup {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipLimited(zip, limits);
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError({ file: ['Not a .hubium archive'] });
  }
  if (!entries['manifest.json']) throw new ValidationError({ file: ['Not a .hubium archive'] });
  const json = (name: string) => {
    const e = entries[name];
    if (!e) throw new ValidationError({ file: [`${name} is missing: not a .hubium archive`] });
    return JSON.parse(strFromU8(e)) as unknown;
  };
  const manifest = Manifest.safeParse(json('manifest.json'));
  if (!manifest.success)
    throw new ValidationError({ file: ['Unsupported backup format or version'] });
  return {
    manifest: manifest.data,
    course: CourseJson.parse(json('course.json')),
    files: z.array(FileRow).parse(json('files.json')),
    blob: (id: string) => entries[`files/${id}`],
  };
}

/** createCourse makes at most this many sections; longer courses get the rest added. */
const MAX_NEW_SECTIONS = 52;

/** Adds sections until the course has `wanted` besides the general one. */
export async function addMissingSections(ctx: RequestContext, courseId: string, wanted: number) {
  const have = (await ctx.db.courseSection.count({ where: { courseId, parentId: null } })) - 1;
  for (let i = have; i < wanted; i++) await addSection.run(ctx, { courseId });
}

/**
 * The archive's sections of the course and its subsections. A subsection whose section is
 * not one of the course's (an altered archive) counts as a section of the course.
 */
function splitSections(sections: z.infer<typeof Section>[]) {
  const ids = new Set(sections.filter((s) => !s.parentId).map((s) => s.id));
  return {
    top: sections.filter((s) => !s.parentId || !ids.has(s.parentId)),
    subs: sections.filter((s) => s.parentId && ids.has(s.parentId)),
  };
}

/** Where a course made from an archive goes, and what it is called there. */
export interface NewCourseTarget {
  categoryId: string;
  fullName?: string;
  shortName?: string;
  /** Called once the course exists, before anything is put in it (a task records it). */
  onCreated?: (courseId: string) => Promise<unknown>;
}

/** Restores a .hubium archive into a new course in `categoryId`. */
export async function restoreCourse(
  ctx: RequestContext,
  zip: Uint8Array,
  target: NewCourseTarget,
): Promise<RestoreReport> {
  return restoreBackup(ctx, readBackup(zip), target);
}

/**
 * Makes a course of a backup. It stays hidden until it is complete; when the restore fails
 * it is deleted again.
 */
async function restoreBackup(
  ctx: RequestContext,
  b: Backup,
  target: NewCourseTarget,
): Promise<RestoreReport> {
  const src = b.course.course;

  const shortName = target.shortName ?? (await freeShortName(ctx.db, src.shortName));
  const sectionsCount = Math.max(0, splitSections(b.course.sections).top.length - 1);
  const { id: courseId } = await createCourse.run(ctx, {
    categoryId: target.categoryId,
    fullName: target.fullName ?? src.fullName,
    shortName,
    format: src.format,
    sections: src.format === 'SINGLE' ? 0 : Math.min(MAX_NEW_SECTIONS, sectionsCount),
    startDate: src.startDate ?? undefined,
    endDate: src.endDate ?? undefined,
    // a language this site does not have is dropped, not an error
    lang: isLocale(src.lang) ? src.lang : null,
    enableCompletion: src.enableCompletion,
    groupMode: src.groupMode,
    groupModeForced: src.groupModeForced,
    visible: false,
  });
  try {
    await target.onCreated?.(courseId);
    await ctx.perm.require('restore:course', courseId).catch(() => {
      throw new ForbiddenError('You cannot restore into this course');
    });
    const report = await restoreInto(ctx, b, courseId, { fresh: true });
    await ctx.db.course.update({ where: { id: courseId }, data: { visible: true } });
    return report;
  } catch (e) {
    // do not leave a half-restored course behind
    await discardCourse(ctx, courseId);
    throw e;
  }
}

/**
 * Copies chosen activities of one course into another (Moodle's "Import"), through the
 * backup pipeline: each lands in the section with the same number, which is added when
 * missing. Their files, the course scales and, for quizzes, the question bank come along;
 * course settings, groups and the gradebook layout of the source stay where they are.
 */
export const ImportActivitiesInput = z.object({
  sourceCourseId: z.string().uuid(),
  targetCourseId: z.string().uuid(),
  activityIds: z.array(z.string().uuid()).max(1000),
});

/**
 * Copies an activity in its own course, as an import of it would: its module's own data
 * (chapters, questions, entries, packages) through the module's backup, its files without
 * learners' work, its grade items and calendar events. The copy comes right after it,
 * hidden, with no ID number.
 */
export async function duplicateActivity(
  ctx: RequestContext,
  activityId: string,
  name: (original: string) => string,
): Promise<{ id: string }> {
  const a = await ctx.db.activity.findUnique({ where: { id: activityId } });
  if (!a || a.deletedAt) throw new NotFoundError('Activity');
  await ctx.perm.require('course:manageactivities', a.courseId);
  await assertModuleEnabled(ctx.db, a.moduleKey);
  const b = await localBackup(ctx, a.courseId, { activityIds: [a.id] });
  const r = await restoreInto(ctx, b, a.courseId, {
    fresh: false,
    duplicate: { name: name(a.name), after: { sectionId: a.sectionId, rank: a.rank } },
  });
  const id = r.activityIds[0];
  if (!id) throw new ValidationError({ id: [r.warnings[0] ?? 'The activity could not be copied'] });
  return { id };
}

export async function importActivities(
  ctx: RequestContext,
  raw: z.input<typeof ImportActivitiesInput>,
): Promise<RestoreReport> {
  const input = parseInput(ImportActivitiesInput, raw);
  if (input.sourceCourseId === input.targetCourseId)
    throw new ValidationError({ sourceCourseId: ['Choose another course'] });
  if (!input.activityIds.length)
    throw new ValidationError({ activityIds: ['Choose at least one activity'] });
  await ctx.perm.require('restore:course', input.targetCourseId);
  await ctx.perm.require('backup:create', input.sourceCourseId);
  const b = await localBackup(ctx, input.sourceCourseId, { activityIds: input.activityIds });
  if (!b.course.activities.length) throw new NotFoundError('Activity');
  return restoreInto(ctx, b, input.targetCourseId, { fresh: false });
}

interface RestoreScope {
  /** A course made for this restore: its settings, groups and gradebook come along. */
  fresh: boolean;
  /** Copying an activity in its own course: placed after it, hidden, under this name. */
  duplicate?: { name: string; after: { sectionId: string; rank: string } };
}

async function restoreInto(
  ctx: RequestContext,
  b: Backup,
  courseId: string,
  scope: RestoreScope,
): Promise<RestoreReport> {
  const warnings: string[] = [];
  const map = new Map<string, string>();
  const src = b.course.course;
  const db = ctx.db;
  const target = await db.course.findUniqueOrThrow({
    where: { id: courseId },
    select: { format: true },
  });
  const activities = b.course.activities;
  map.set(src.id, courseId);
  // Into the very course the archive comes from (a duplicate): its sections, groups,
  // question bank and gradebook are those already there, named by the same ids.
  const same = !scope.fresh && src.id === courseId;
  // what an import into an existing course made, removed again if it fails
  const made = { activities: [] as string[], categories: [] as string[] };
  try {
    // sections: the one with the same number, added when the course has fewer; an import
    // puts what was in a subsection into its section
    const { top, subs } = splitSections(b.course.sections);
    const sectionIndex = new Map(top.map((s, i) => [s.id, i]));
    for (const s of subs) sectionIndex.set(s.id, sectionIndex.get(s.parentId!)!);
    const needed = scope.fresh
      ? Math.max(0, top.length - 1)
      : Math.max(0, ...activities.map((a) => sectionIndex.get(a.sectionId) ?? 0));
    const before = await db.courseSection.count({ where: { courseId, parentId: null } });
    if (target.format !== 'SINGLE') await addMissingSections(ctx, courseId, needed);
    const newSections = await db.courseSection.findMany({
      where: { courseId, parentId: null },
      orderBy: { rank: 'asc' },
    });
    top.forEach((s, i) => {
      const t = newSections[i] ?? newSections.at(-1)!;
      map.set(s.id, t.id);
    });
    // a restored course gets its subsections back (placed among the activities below)
    const newSubs = new Map<string, string>();
    for (const s of subs) {
      if (!scope.fresh || target.format === 'SINGLE') {
        map.set(s.id, map.get(s.parentId!)!);
        continue;
      }
      const id = uuidv7();
      map.set(s.id, id);
      newSubs.set(s.id, id);
      await db.courseSection.create({
        data: {
          id,
          courseId,
          parentId: map.get(s.parentId!)!,
          rank: rankBetween(null, null),
          title: s.title.slice(0, 255),
          visible: s.visible,
        },
      });
    }

    if (same)
      for (const x of [...b.course.sections, ...b.course.groups, ...b.course.groupings])
        map.set(x.id, x.id);
    if (scope.fresh)
      for (const g of b.course.groups) {
        const id = uuidv7();
        map.set(g.id, id);
        await db.group.create({
          data: { id, courseId, name: g.name, description: g.description, idNumber: g.idNumber },
        });
      }
    // gradebook setup first: activities refer to course scales in their settings
    const gb = b.course.gradebook;
    const { root: gradeRoot } = await ensureCourseGradebook(db, courseId);
    if (gb && same) for (const c of gb.categories) map.set(c.id, c.id);
    if (gb) {
      for (const sc of gb.scales) {
        const same = scope.fresh
          ? null
          : await db.scale.findFirst({ where: { courseId, name: sc.name } });
        if (same) {
          map.set(sc.id, same.id);
          continue;
        }
        const id = uuidv7();
        map.set(sc.id, id);
        await db.scale.create({ data: { id, courseId, name: sc.name, items: sc.items } });
      }
      if (scope.fresh) {
        const oldRoot = gb.categories.find((c) => !c.parentId);
        if (oldRoot) {
          map.set(oldRoot.id, gradeRoot.id);
          await db.gradeCategory.update({
            where: { id: gradeRoot.id },
            data: {
              aggregation: oldRoot.aggregation,
              dropLowest: oldRoot.dropLowest,
              keepHighest: oldRoot.keepHighest,
              aggregateOnlyGraded: oldRoot.aggregateOnlyGraded,
            },
          });
        }
        const pending = gb.categories.filter((c) => c.parentId);
        while (pending.length) {
          const i = pending.findIndex((c) => map.has(c.parentId!));
          const c = pending.splice(i === -1 ? 0 : i, 1)[0]!;
          const id = uuidv7();
          map.set(c.id, id);
          await db.gradeCategory.create({
            data: {
              id,
              courseId,
              parentId: map.get(c.parentId!) ?? gradeRoot.id,
              name: c.name,
              aggregation: c.aggregation,
              dropLowest: c.dropLowest,
              keepHighest: c.keepHighest,
              aggregateOnlyGraded: c.aggregateOnlyGraded,
              hidden: c.hidden,
              weight: c.weight,
              sortOrder: c.sortOrder,
              idNumber: c.idNumber,
            },
          });
        }
        if (gb.letters.length)
          await db.gradeLetter.createMany({
            data: gb.letters.map((l) => ({ contextId: courseId, ...l })),
          });
      }
    }

    if (scope.fresh)
      for (const g of b.course.groupings) {
        const id = uuidv7();
        map.set(g.id, id);
        await db.grouping.create({
          data: {
            id,
            courseId,
            name: g.name,
            description: g.description,
            groups: {
              create: g.groupIds.flatMap((gid) =>
                map.has(gid) ? [{ groupId: map.get(gid)! }] : [],
              ),
            },
          },
        });
      }

    // question bank: parents first (an import brings it only for quizzes)
    const withBank = scope.fresh || (!same && activities.some((a) => a.moduleKey === 'quiz'));
    if (same)
      for (const x of [...b.course.questionCategories, ...b.course.questions]) map.set(x.id, x.id);
    const pending = withBank ? [...b.course.questionCategories] : [];
    while (pending.length) {
      const i = pending.findIndex((c) => !c.parentId || map.has(c.parentId));
      const c = pending.splice(i === -1 ? 0 : i, 1)[0]!;
      const id = uuidv7();
      map.set(c.id, id);
      made.categories.push(id);
      await db.questionCategory.create({
        data: {
          id,
          contextId: courseId,
          parentId: c.parentId ? (map.get(c.parentId) ?? null) : null,
          // an imported top category says where it came from
          name: !scope.fresh && !c.parentId ? `${c.name} (${src.shortName})` : c.name,
          info: c.info,
          sortOrder: c.sortOrder,
        },
      });
    }
    for (const d of withBank ? b.course.questionDatasets : []) {
      const categoryId = map.get(d.categoryId);
      if (!categoryId) continue;
      await db.questionDataset.create({
        data: {
          categoryId,
          name: d.name,
          min: d.min,
          max: d.max,
          decimals: d.decimals,
          distribution: d.distribution === 'loguniform' ? 'LOGUNIFORM' : 'UNIFORM',
          items: d.items,
        },
      });
    }
    for (const q of withBank ? b.course.questions : []) {
      const categoryId = map.get(q.categoryId);
      // The archive is untrusted: only known types with valid data make it into the bank.
      const data = questionTypes.includes(q.type as QuestionType)
        ? questionDataSchemas[q.type as QuestionType].safeParse(q.data)
        : null;
      if (!categoryId || !data?.success) {
        warnings.push(`Question "${q.name}" could not be restored`);
        continue;
      }
      const id = uuidv7();
      map.set(q.id, id);
      await db.question.create({
        data: {
          id,
          categoryId,
          type: q.type as QuestionType,
          name: q.name,
          text: sanitizeRichText(q.text),
          generalFeedback: sanitizeRichText(q.generalFeedback),
          defaultMark: q.defaultMark,
          penalty: q.penalty,
          hints: q.hints.map((h) => ({
            ...h,
            text: sanitizeRichText(h.text),
          })) as unknown as Prisma.InputJsonValue,
          data: data.data as Prisma.InputJsonValue,
          status: q.status,
          tags: q.tags,
          idNumber: q.idNumber,
          source: 'IMPORT',
          createdById: ctx.perm.userId ?? null,
        },
      });
    }

    // activities (availability and cross references are fixed up after all exist)
    const created: { row: z.infer<typeof ActivityRow>; id: string }[] = [];
    for (const a of activities) {
      const known = getModule(a.moduleKey);
      const sectionId = map.get(a.sectionId) ?? newSections[0]!.id;
      if (!known) {
        warnings.push(
          `Unknown activity type "${a.moduleKey}" (${a.name}) was replaced with a label`,
        );
        const { id } = await importActivity.run(ctx, {
          courseId,
          sectionId,
          moduleKey: 'label',
          name: a.name,
          settings: { content: `<p>${a.name}</p>` },
        });
        map.set(a.id, id);
        made.activities.push(id);
        continue;
      }
      try {
        const { id } = await importActivity.run(ctx, {
          courseId,
          sectionId,
          moduleKey: a.moduleKey,
          name: scope.duplicate?.name ?? a.name,
          intro: rewriteIds(a.intro, map),
          showIntro: a.showIntro,
          // a copy waits hidden until it is looked over
          visibility: scope.duplicate ? 'HIDDEN' : a.visibility,
          completionMode: a.completionMode,
          completionRules: a.completionRules,
          completionExpectedAt: a.completionExpectedAt,
          groupMode: a.groupMode,
          groupingId: a.groupingId ? (map.get(a.groupingId) ?? null) : null,
          settings: rewriteJson(a.settings, map),
        });
        map.set(a.id, id);
        made.activities.push(id);
        created.push({ row: a, id });
        if (scope.duplicate) {
          // right after the activity it copies
          const { after } = scope.duplicate;
          const next = await db.activity.findFirst({
            where: { sectionId: after.sectionId, rank: { gt: after.rank }, id: { not: id } },
            orderBy: { rank: 'asc' },
            select: { rank: true },
          });
          await db.activity.update({
            where: { id },
            data: { sectionId: after.sectionId, rank: rankBetween(after.rank, next?.rank ?? null) },
          });
        }
      } catch (e) {
        warnings.push(
          `"${a.name}" could not be restored: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // competencies, where the site has them
    if (b.course.competencies)
      warnings.push(
        ...(await restoreCompetencies(db, b.course.competencies, courseId, map, scope.fresh)),
      );

    // course badges, as drafts to look over: their rules keep what they still point to
    const roles = new Set((await db.role.findMany({ select: { id: true } })).map((r) => r.id));
    const badges: { id: string; imageFileId: string | null }[] = [];
    for (const x of scope.fresh ? b.course.badges : []) {
      const id = uuidv7();
      map.set(x.id, id);
      const rules = ((rewriteJson(x.criteria, map) as { rules?: BadgeRuleT[] })?.rules ?? [])
        .map((r) =>
          r.kind === 'activities'
            ? { ...r, activityIds: r.activityIds.filter((a) => created.some((c) => c.id === a)) }
            : r.kind === 'manual'
              ? { ...r, roleIds: r.roleIds.filter((role) => roles.has(role)) }
              : r,
        )
        .filter((r) => !('activityIds' in r && !r.activityIds.length))
        .filter((r) => !('roleIds' in r && !r.roleIds.length));
      let criteria: BadgeCriteriaT = { method: 'all', rules: [] };
      try {
        criteria = checkCriteria(
          { method: (x.criteria as { method?: string })?.method, rules },
          false,
        );
      } catch {
        warnings.push(`The criteria of the badge "${x.name}" could not be restored`);
      }
      await db.badge.create({
        data: {
          id,
          courseId,
          name: x.name.slice(0, 255),
          description: x.description.slice(0, 5000),
          criteria: criteria as unknown as Prisma.InputJsonValue,
          expiresAfterDays: x.expiresAfterDays,
          expiresAt: x.expiresAt ? new Date(x.expiresAt) : null,
          status: 'DRAFT',
          createdById: ctx.perm.userId ?? null,
        },
      });
      badges.push({ id, imageFileId: x.imageFileId });
    }

    // course certificates, as drafts to look over
    const certificates: { id: string; backgroundFileId: string | null }[] = [];
    for (const x of scope.fresh ? b.course.certificates : []) {
      const id = uuidv7();
      map.set(x.id, id);
      await db.certificate.create({
        data: {
          id,
          courseId,
          name: x.name.slice(0, 255),
          orientation: x.orientation === 'portrait' ? 'portrait' : 'landscape',
          fields: CertificateFields.catch([]).parse(x.fields) as unknown as Prisma.InputJsonValue,
          onCompletion: x.onCompletion,
          status: 'DRAFT',
          createdById: ctx.perm.userId ?? null,
        },
      });
      certificates.push({ id, backgroundFileId: x.backgroundFileId });
    }

    let fileCount = 0;
    // a copy on this site: the content each file names, as it is stored
    const stored = b.local
      ? new Map(
          (
            await db.fileBlob.findMany({
              where: { id: { in: [...new Set(b.files.map((f) => f.blobId))] } },
              select: { id: true, size: true },
            })
          ).map((x) => [x.id, x]),
        )
      : null;
    for (const f of b.files) {
      const contextId = map.get(f.contextId);
      const data = stored ? null : b.blob(f.blobId);
      const blob = stored?.get(f.blobId);
      if (!contextId || !(data || blob)) continue;
      const address = {
        contextId,
        component: f.component,
        area: f.area,
        itemId: map.get(f.itemId) ?? f.itemId,
        path: f.path,
        name: f.name,
      };
      // A file already at the address (the course's own picture, imported a second time):
      // the same content is that file; other content goes to a folder of its own.
      const there = await db.file.findFirst({ where: address, include: { blob: true } });
      if (there) {
        const same = data
          ? there.blob.sha256 === createHash('sha256').update(data).digest('hex')
          : there.blobId === f.blobId;
        if (same) {
          map.set(f.id, there.id);
          continue;
        }
        address.path = `${f.path}${uuidv7().slice(-12)}/`;
      }
      const nf = data
        ? await storeFile(db, {
            ...address,
            mimeType: f.mimeType,
            data: Buffer.from(data),
            uploadedById: ctx.perm.userId ?? null,
          })
        : await db.file.create({
            data: {
              ...address,
              blobId: f.blobId,
              mimeType: f.mimeType,
              size: blob!.size,
              uploadedById: ctx.perm.userId ?? null,
            },
          });
      map.set(f.id, nf.id);
      fileCount++;
    }

    for (const x of certificates)
      if (x.backgroundFileId && map.has(x.backgroundFileId))
        await db.certificate.update({
          where: { id: x.id },
          data: { backgroundFileId: map.get(x.backgroundFileId)! },
        });
    for (const x of badges)
      if (x.imageFileId && map.has(x.imageFileId))
        await db.badge.update({
          where: { id: x.id },
          data: { imageFileId: map.get(x.imageFileId)! },
        });

    // second pass: references to activities, files and groups
    if (scope.fresh)
      await db.course.update({
        where: { id: courseId },
        data: {
          summary: sanitizeRichText(rewriteIds(src.summary, map)),
          formatOptions: rewriteJson(src.formatOptions, map) as Prisma.InputJsonValue,
          completionSettings: rewriteJson(src.completionSettings, map) as Prisma.InputJsonValue,
          settings: rewriteJson(src.settings, map) as Prisma.InputJsonValue,
          // values for the fields this site has
          customFields: foreignCourseValues(await listCourseFields(db), src.customFields),
        },
      });
    const availability = (tree: unknown) => {
      const kept = scope.fresh ? tree : pruneAvailability(tree, map);
      return kept ? (rewriteJson(kept, map) as Prisma.InputJsonValue) : undefined;
    };
    for (const [i, s] of top.entries()) {
      const t = newSections[i];
      // an import names only the sections it added
      if (!t || (!scope.fresh && i < before)) continue;
      await db.courseSection.update({
        where: { id: t.id },
        data: {
          title: s.title,
          summary: sanitizeRichText(rewriteIds(s.summary, map)),
          visible: s.visible,
          availability: availability(s.availability),
        },
      });
    }
    // each subsection back in its place among its section's activities
    const placed = new Map<string, { rank: string | null; position: number }>();
    for (const s of subs) {
      const id = newSubs.get(s.id);
      if (!id) continue;
      const parentId = map.get(s.parentId!)!;
      const acts = await db.activity.findMany({
        where: { sectionId: parentId, deletedAt: null },
        orderBy: { rank: 'asc' },
        select: { rank: true },
      });
      const last = placed.get(parentId) ?? { rank: null, position: 0 };
      const position = Math.max(last.position, Math.min(s.position, acts.length));
      const after = acts[position]?.rank ?? null;
      const prev = acts[position - 1]?.rank ?? null;
      const rank = rankBetween(last.rank && (!prev || last.rank > prev) ? last.rank : prev, after);
      placed.set(parentId, { rank, position });
      await db.courseSection.update({
        where: { id },
        data: {
          rank,
          summary: sanitizeRichText(rewriteIds(s.summary, map)),
          availability: availability(s.availability),
        },
      });
    }
    for (const { row, id } of created) {
      // Same checks as importActivity, which only saw the archive's settings before ids were mapped.
      const idNumber = scope.fresh
        ? row.idNumber
        : await freeIdNumber(db, courseId, row.idNumber, id);
      await db.activity.update({
        where: { id },
        data: {
          intro: sanitizeRichText(rewriteIds(row.intro, map)),
          settings: parseSettings(
            getModule(row.moduleKey)!,
            rewriteJson(row.settings, map),
          ) as Prisma.InputJsonValue,
          availability: availability(row.availability),
          idNumber,
        },
      });
    }
    for (const { row, id } of created) {
      const m = getModule(row.moduleKey);
      if (!m?.backup?.import) continue;
      const act = await db.activity.findUniqueOrThrow({ where: { id } });
      await db.$transaction((tx) =>
        m.backup!.import!(buildModuleCtx(ctx, tx), toActivityRef(act) as never, row.module, (old) =>
          map.get(old),
        ),
      );
    }
    if (gb) {
      // formulas refer to items and categories by id: they follow them to the copy
      const formulas: { id: string; calculation: string }[] = [];
      for (const it of gb.items) {
        const common = {
          categoryId: it.categoryId ? (map.get(it.categoryId) ?? gradeRoot.id) : gradeRoot.id,
          weight: it.weight,
          decimals: it.decimals,
          display: it.display,
          hidden: it.hidden,
          locked: it.locked,
          sortOrder: it.sortOrder,
          gradePass: it.gradePass,
          idNumber: it.idNumber,
        };
        if (it.kind === 'MANUAL') {
          // an import brings activities only
          if (!scope.fresh) continue;
          // a site scale only exists on the site the course came from
          const scaleId = it.scaleId
            ? (map.get(it.scaleId) ??
              (await db.scale.findFirst({ where: { id: it.scaleId, courseId: null } }))?.id ??
              null)
            : null;
          const item = await db.gradeItem.create({
            data: {
              ...common,
              courseId,
              kind: 'MANUAL',
              name: it.name,
              gradeType: scaleId ? 'SCALE' : it.gradeType === 'SCALE' ? 'VALUE' : it.gradeType,
              scaleId,
              gradeMin: scaleId ? 1 : it.gradeType === 'SCALE' ? 0 : it.gradeMin,
              gradeMax: it.gradeMax,
            },
          });
          if (it.id) map.set(it.id, item.id);
          if (it.calculation && item.gradeType === 'VALUE')
            formulas.push({ id: item.id, calculation: it.calculation });
        } else {
          const activityId = it.activityId ? map.get(it.activityId) : undefined;
          if (!activityId) continue;
          // settings now refer to the restored scales
          await syncGradeItemsFor(db, activityId);
          await db.gradeItem.updateMany({
            where: { activityId, itemNumber: it.itemNumber },
            // an import puts the items in the course's top category
            data: scope.fresh
              ? common
              : {
                  ...common,
                  // a copy in its own course stays in its category, an import goes to the top
                  categoryId: same ? common.categoryId : gradeRoot.id,
                  idNumber: await freeIdNumber(db, courseId, it.idNumber, activityId),
                },
          });
          const copy = await db.gradeItem.findFirst({
            where: { activityId, itemNumber: it.itemNumber },
            select: { id: true },
          });
          if (it.id && copy) map.set(it.id, copy.id);
        }
      }
      // a reference to something left out stays as it was, and shows as broken
      for (const f of formulas)
        await db.gradeItem.update({
          where: { id: f.id },
          data: {
            calculation: f.calculation.replace(
              /##g([ic])([0-9a-f-]{36})##/g,
              (all, kind: string, old: string) => {
                const to = map.get(old);
                return to ? `##g${kind}${to}##` : all;
              },
            ),
          },
        });
    }
    return {
      courseId,
      sections: scope.fresh ? top.length : newSections.length - before,
      activities: created.length,
      activityIds: created.map((c) => c.id),
      questions: withBank ? b.course.questions.length : 0,
      files: fileCount,
      warnings: [...warnings, ...disabledTypesWarning(await disabledTypesIn(db, courseId))],
    };
  } catch (e) {
    // a fresh course is discarded by the caller; an import takes back what it added
    if (!scope.fresh) {
      // as deleting them for good does: the modules' clean-up, contexts, calendar events
      for (const id of made.activities) {
        const a = await db.activity.findUnique({ where: { id } });
        if (a) await db.$transaction((tx) => purgeActivityRecord(ctx, tx, a)).catch(() => {});
      }
      if (made.categories.length)
        await db.questionCategory
          .deleteMany({ where: { id: { in: made.categories } } })
          .catch(() => {});
    }
    throw e;
  }
}

/**
 * An ID number an import keeps only when nothing else in the course goes by it: activities
 * and the gradebook share them (formulas refer to them), whatever the case.
 */
async function freeIdNumber(
  db: RequestContext['db'],
  courseId: string,
  idNumber: string | null,
  activityId: string,
): Promise<string | null> {
  if (!idNumber) return null;
  const where = { courseId, idNumber: { equals: idNumber, mode: 'insensitive' as const } };
  const [activity, item, category] = await Promise.all([
    db.activity.findFirst({
      where: { ...where, deletedAt: null, id: { not: activityId } },
      select: { id: true },
    }),
    db.gradeItem.findFirst({
      where: { ...where, OR: [{ activityId: null }, { activityId: { not: activityId } }] },
      select: { id: true },
    }),
    db.gradeCategory.findFirst({ where, select: { id: true } }),
  ]);
  return activity || item || category ? null : idNumber;
}

/**
 * Removes a course that an import gave up on, as deleting it for good does (the modules'
 * clean-up of stored packages and media included). Should that fail on what was half made,
 * the rows go all the same; its question bank is keyed by context id without a foreign key.
 */
export async function discardCourse(ctx: RequestContext, courseId: string) {
  try {
    await ctx.db.$transaction((tx) => purgeCourseRecord(ctx, tx, courseId), { timeout: 300_000 });
  } catch {
    await ctx.db.course.delete({ where: { id: courseId } }).catch(() => {});
    await ctx.db.context.delete({ where: { id: courseId } }).catch(() => {});
    await ctx.db.questionCategory.deleteMany({ where: { contextId: courseId } }).catch(() => {});
  }
}

/** Copies a course on this site: through the backup pipeline, without an archive. */
export async function duplicateCourse(
  ctx: RequestContext,
  courseId: string,
  target: { categoryId?: string; fullName: string; shortName: string },
): Promise<RestoreReport> {
  await ctx.perm.require('backup:create', courseId);
  const src = await ctx.db.course.findUniqueOrThrow({
    where: { id: courseId },
    select: { categoryId: true },
  });
  return restoreBackup(ctx, await localBackup(ctx, courseId, {}), {
    categoryId: target.categoryId ?? src.categoryId,
    fullName: target.fullName,
    shortName: target.shortName,
  });
}

// ── competencies ─────────────────────────────────────────────────────────────

const OUTCOMES = ['NONE', 'EVIDENCE', 'RECOMMEND', 'COMPLETE'] as const;
type Outcome = (typeof OUTCOMES)[number];
const outcomeOf = (v: string): Outcome =>
  (OUTCOMES as readonly string[]).includes(v) ? (v as Outcome) : 'NONE';

async function exportCompetencies(
  db: Db,
  courseId: string,
  activityIds: string[],
  withCourse: boolean,
) {
  const [settings, course, acts] = await Promise.all([
    db.courseCompetencySettings.findUnique({ where: { courseId } }),
    withCourse
      ? db.courseCompetency.findMany({
          where: { courseId },
          orderBy: { sortOrder: 'asc' },
          include: { competency: { include: { framework: { select: { idNumber: true } } } } },
        })
      : [],
    db.activityCompetency.findMany({
      where: { activityId: { in: activityIds } },
      orderBy: { sortOrder: 'asc' },
      include: { competency: { include: { framework: { select: { idNumber: true } } } } },
    }),
  ]);
  return {
    pushRatings: settings?.pushRatings ?? true,
    course: course.map((l) => ({
      framework: l.competency.framework.idNumber,
      idNumber: l.competency.idNumber,
      ruleOutcome: l.ruleOutcome,
    })),
    activities: acts.map((l) => ({
      activityId: l.activityId,
      framework: l.competency.framework.idNumber,
      idNumber: l.competency.idNumber,
      ruleOutcome: l.ruleOutcome,
    })),
  };
}

/**
 * Links the restored course and activities to the site's competencies with the same
 * framework and competency ID numbers; what the site does not have is reported.
 */
export async function restoreCompetencies(
  db: Prisma.TransactionClient | Db,
  c: {
    pushRatings: boolean;
    course: { framework: string; idNumber: string; ruleOutcome: string }[];
    activities: { activityId: string; framework: string; idNumber: string; ruleOutcome: string }[];
  },
  courseId: string,
  map: Map<string, string>,
  fresh: boolean,
): Promise<string[]> {
  const cache = new Map<string, string | null>();
  const find = async (framework: string, idNumber: string) => {
    const key = `${framework}\u0000${idNumber}`;
    if (!cache.has(key)) {
      const found = await db.competency.findFirst({
        where: { idNumber, framework: { idNumber: framework } },
        select: { id: true },
      });
      cache.set(key, found?.id ?? null);
    }
    return cache.get(key)!;
  };
  const missing = new Set<string>();
  const linkCourse = async (competencyId: string, ruleOutcome: Outcome | null) => {
    const last = await db.courseCompetency.aggregate({
      where: { courseId },
      _max: { sortOrder: true },
    });
    await db.courseCompetency.upsert({
      where: { courseId_competencyId: { courseId, competencyId } },
      create: {
        courseId,
        competencyId,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
        ruleOutcome: ruleOutcome ?? 'NONE',
      },
      update: ruleOutcome ? { ruleOutcome } : {},
    });
  };
  if (fresh)
    await db.courseCompetencySettings.upsert({
      where: { courseId },
      create: { courseId, pushRatings: c.pushRatings },
      update: { pushRatings: c.pushRatings },
    });
  for (const l of c.course) {
    const id = await find(l.framework, l.idNumber);
    if (!id) missing.add(`${l.framework}/${l.idNumber}`);
    else await linkCourse(id, outcomeOf(l.ruleOutcome));
  }
  for (const l of c.activities) {
    const activityId = map.get(l.activityId);
    if (!activityId) continue;
    const id = await find(l.framework, l.idNumber);
    if (!id) {
      missing.add(`${l.framework}/${l.idNumber}`);
      continue;
    }
    // an activity's competency is one of its course's
    await linkCourse(id, null);
    await db.activityCompetency.upsert({
      where: { activityId_competencyId: { activityId, competencyId: id } },
      create: { activityId, competencyId: id, ruleOutcome: outcomeOf(l.ruleOutcome) },
      update: { ruleOutcome: outcomeOf(l.ruleOutcome) },
    });
  }
  return missing.size
    ? [`Competencies this site does not have were left out: ${[...missing].join(', ')}`]
    : [];
}
