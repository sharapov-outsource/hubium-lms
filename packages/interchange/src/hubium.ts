import {
  addSection,
  buildModuleCtx,
  createActivity,
  createCourse,
  ensureCourseGradebook,
  ForbiddenError,
  getModule,
  type RequestContext,
  syncGradeItemsFor,
  toActivityRef,
  ValidationError,
} from '@hubium/core';
import { storeFile } from '@hubium/core/files/files';
import { getStorage } from '@hubium/core/files/storage';
import { type Prisma, uuidv7 } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { isLocale } from '@hubium/i18n';
import { parseSettings } from '@hubium/module-sdk';
import { type QuestionType, questionDataSchemas, questionTypes } from '@hubium/questions';
import { strFromU8, strToU8, zipSync } from 'fflate';
import { z } from 'zod';
import { type ArchiveLimits, unzipLimited } from './archive.ts';

// The .hubium course format: a zip with manifest.json, course.json, files.json and
// files/<blobId>. Restoring maps every id from the source course to a new one, so the
// same pipeline also duplicates courses. Learners' data is not included.

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
    }),
  ),
  scales: z.array(z.object({ id: z.string(), name: z.string(), items: z.array(z.string()) })),
  letters: z.array(z.object({ lowerBound: z.number(), letter: z.string() })),
  items: z.array(
    z.object({
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
  }),
  sections: z.array(Section),
  activities: z.array(ActivityRow),
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

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream)
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as unknown as Uint8Array));
  return Buffer.concat(chunks);
}

/** Builds a .hubium archive of a course (structure, content, question bank, files). */
export async function exportCourse(ctx: RequestContext, courseId: string): Promise<Uint8Array> {
  await ctx.perm.require('backup:create', courseId);
  const db = ctx.db;
  const course = await db.course.findUniqueOrThrow({ where: { id: courseId } });
  const sections = await db.courseSection.findMany({
    where: { courseId },
    orderBy: { rank: 'asc' },
  });
  const activities = await db.activity.findMany({
    where: { courseId, deletedAt: null },
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
  const files = (
    await db.file.findMany({
      where: { contextId: { in: [courseId, ...activities.map((a) => a.id)] } },
      include: { blob: true },
    })
  ).filter((f) => !(userAreas.get(f.contextId) ?? []).includes(f.area));

  const out: Record<string, Uint8Array> = {};
  let total = 0;
  for (const f of files) {
    const key = `files/${f.blobId}`;
    if (out[key]) continue;
    total += Number(f.blob.size);
    if (total > MAX_BACKUP_BYTES)
      throw new ValidationError({ course: ['The course is too large to back up'] });
    out[key] = await readAll(await getStorage().getStream(f.blob.storageKey));
  }
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
    },
    sections: sections.map((s) => ({
      id: s.id,
      title: s.title,
      summary: s.summary,
      visible: s.visible,
      availability: s.availability ?? null,
    })),
    activities: actRows,
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
      })),
      scales: scales.map((x) => ({ id: x.id, name: x.name, items: x.items })),
      letters: letters.map((l) => ({ lowerBound: l.lowerBound.toNumber(), letter: l.letter })),
      items: gradeItems
        .filter((i) => i.kind === 'MANUAL' || (i.activityId && exported.has(i.activityId)))
        .map((i) => ({
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
        })),
    },
    questionCategories: categories.map((c) => ({
      id: c.id,
      parentId: c.parentId,
      name: c.name,
      info: c.info,
      sortOrder: c.sortOrder,
    })),
    questions: questions.map((q) => ({
      id: q.id,
      categoryId: q.categoryId,
      type: q.type,
      name: q.name,
      text: q.text,
      generalFeedback: q.generalFeedback,
      defaultMark: Number(q.defaultMark),
      penalty: Number(q.penalty),
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
  out['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  out['course.json'] = strToU8(JSON.stringify(body));
  out['files.json'] = strToU8(JSON.stringify(fileRows));
  return zipSync(out, { level: 6 });
}

export interface RestoreReport {
  courseId: string;
  sections: number;
  activities: number;
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

/** Reads and validates a .hubium archive. */
export function readBackup(zip: Uint8Array, limits?: ArchiveLimits) {
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
  const have = (await ctx.db.courseSection.count({ where: { courseId } })) - 1;
  for (let i = have; i < wanted; i++) await addSection.run(ctx, { courseId });
}

/** Restores a .hubium archive into a new course in `categoryId`. */
export async function restoreCourse(
  ctx: RequestContext,
  zip: Uint8Array,
  target: { categoryId: string; fullName?: string; shortName?: string },
): Promise<RestoreReport> {
  const b = readBackup(zip);
  const warnings: string[] = [];
  const map = new Map<string, string>();
  const src = b.course.course;

  let shortName = target.shortName ?? src.shortName;
  if (!target.shortName) {
    for (let i = 1; await ctx.db.course.findUnique({ where: { shortName } }); i++)
      shortName = `${src.shortName}-${i}`;
  }
  const sectionsCount = Math.max(0, b.course.sections.length - 1);
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
  });
  map.set(src.id, courseId);
  try {
    await ctx.perm.require('restore:course', courseId).catch(() => {
      throw new ForbiddenError('You cannot restore into this course');
    });
    const db = ctx.db;
    if (src.format !== 'SINGLE') await addMissingSections(ctx, courseId, sectionsCount);
    const newSections = await db.courseSection.findMany({
      where: { courseId },
      orderBy: { rank: 'asc' },
    });
    b.course.sections.forEach((s, i) => {
      const target = newSections[i] ?? newSections.at(-1)!;
      map.set(s.id, target.id);
    });

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
    if (gb) {
      for (const sc of gb.scales) {
        const id = uuidv7();
        map.set(sc.id, id);
        await db.scale.create({ data: { id, courseId, name: sc.name, items: sc.items } });
      }
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
          },
        });
      }
      if (gb.letters.length)
        await db.gradeLetter.createMany({
          data: gb.letters.map((l) => ({ contextId: courseId, ...l })),
        });
    }

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
            create: g.groupIds.flatMap((gid) => (map.has(gid) ? [{ groupId: map.get(gid)! }] : [])),
          },
        },
      });
    }

    // question bank: parents first
    const pending = [...b.course.questionCategories];
    while (pending.length) {
      const i = pending.findIndex((c) => !c.parentId || map.has(c.parentId));
      const c = pending.splice(i === -1 ? 0 : i, 1)[0]!;
      const id = uuidv7();
      map.set(c.id, id);
      await db.questionCategory.create({
        data: {
          id,
          contextId: courseId,
          parentId: c.parentId ? (map.get(c.parentId) ?? null) : null,
          name: c.name,
          info: c.info,
          sortOrder: c.sortOrder,
        },
      });
    }
    for (const q of b.course.questions) {
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
    for (const a of b.course.activities) {
      const known = getModule(a.moduleKey);
      const sectionId = map.get(a.sectionId) ?? newSections[0]!.id;
      if (!known) {
        warnings.push(
          `Unknown activity type "${a.moduleKey}" (${a.name}) was replaced with a label`,
        );
        const { id } = await createActivity.run(ctx, {
          courseId,
          sectionId,
          moduleKey: 'label',
          name: a.name,
          settings: { content: `<p>${a.name}</p>` },
        });
        map.set(a.id, id);
        continue;
      }
      try {
        const { id } = await createActivity.run(ctx, {
          courseId,
          sectionId,
          moduleKey: a.moduleKey,
          name: a.name,
          intro: rewriteIds(a.intro, map),
          showIntro: a.showIntro,
          visibility: a.visibility,
          completionMode: a.completionMode,
          completionRules: a.completionRules,
          completionExpectedAt: a.completionExpectedAt,
          groupMode: a.groupMode,
          groupingId: a.groupingId ? (map.get(a.groupingId) ?? null) : null,
          settings: rewriteJson(a.settings, map),
        });
        map.set(a.id, id);
        created.push({ row: a, id });
      } catch (e) {
        warnings.push(
          `"${a.name}" could not be restored: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // files
    let fileCount = 0;
    for (const f of b.files) {
      const contextId = map.get(f.contextId);
      const data = b.blob(f.blobId);
      if (!contextId || !data) continue;
      const nf = await storeFile(db, {
        contextId,
        component: f.component,
        area: f.area,
        itemId: map.get(f.itemId) ?? f.itemId,
        path: f.path,
        name: f.name,
        mimeType: f.mimeType,
        data: Buffer.from(data),
        uploadedById: ctx.perm.userId ?? null,
      });
      map.set(f.id, nf.id);
      fileCount++;
    }

    // second pass: references to activities, files and groups
    await db.course.update({
      where: { id: courseId },
      data: {
        summary: sanitizeRichText(rewriteIds(src.summary, map)),
        formatOptions: rewriteJson(src.formatOptions, map) as Prisma.InputJsonValue,
        completionSettings: rewriteJson(src.completionSettings, map) as Prisma.InputJsonValue,
        settings: rewriteJson(src.settings, map) as Prisma.InputJsonValue,
      },
    });
    for (const [i, s] of b.course.sections.entries()) {
      const target = newSections[i];
      if (!target) continue;
      await db.courseSection.update({
        where: { id: target.id },
        data: {
          title: s.title,
          summary: sanitizeRichText(rewriteIds(s.summary, map)),
          visible: s.visible,
          availability: s.availability
            ? (rewriteJson(s.availability, map) as Prisma.InputJsonValue)
            : undefined,
        },
      });
    }
    for (const { row, id } of created) {
      // Same checks as createActivity, which only saw the archive's settings before ids were mapped.
      await db.activity.update({
        where: { id },
        data: {
          intro: sanitizeRichText(rewriteIds(row.intro, map)),
          settings: parseSettings(
            getModule(row.moduleKey)!,
            rewriteJson(row.settings, map),
          ) as Prisma.InputJsonValue,
          availability: row.availability
            ? (rewriteJson(row.availability, map) as Prisma.InputJsonValue)
            : undefined,
          idNumber: row.idNumber,
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
          // a site scale only exists on the site the course came from
          const scaleId = it.scaleId
            ? (map.get(it.scaleId) ??
              (await db.scale.findFirst({ where: { id: it.scaleId, courseId: null } }))?.id ??
              null)
            : null;
          await db.gradeItem.create({
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
        } else {
          const activityId = it.activityId ? map.get(it.activityId) : undefined;
          if (!activityId) continue;
          // settings now refer to the restored scales
          await syncGradeItemsFor(db, activityId);
          await db.gradeItem.updateMany({
            where: { activityId, itemNumber: it.itemNumber },
            data: common,
          });
        }
      }
    }
    return {
      courseId,
      sections: b.course.sections.length,
      activities: created.length,
      questions: b.course.questions.length,
      files: fileCount,
      warnings,
    };
  } catch (e) {
    // do not leave a half-restored course behind
    await discardCourse(ctx, courseId);
    throw e;
  }
}

/**
 * Removes a course that an import gave up on. Its question bank is keyed by context id
 * without a foreign key, so it goes explicitly, after the quizzes that use it.
 */
export async function discardCourse(ctx: RequestContext, courseId: string) {
  await ctx.db.course.delete({ where: { id: courseId } }).catch(() => {});
  await ctx.db.context.delete({ where: { id: courseId } }).catch(() => {});
  await ctx.db.questionCategory.deleteMany({ where: { contextId: courseId } }).catch(() => {});
}

/** Copies a course through the backup pipeline. */
export async function duplicateCourse(
  ctx: RequestContext,
  courseId: string,
  target: { categoryId?: string; fullName: string; shortName: string },
): Promise<RestoreReport> {
  const zip = await exportCourse(ctx, courseId);
  const src = await ctx.db.course.findUniqueOrThrow({
    where: { id: courseId },
    select: { categoryId: true },
  });
  return restoreCourse(ctx, zip, {
    categoryId: target.categoryId ?? src.categoryId,
    fullName: target.fullName,
    shortName: target.shortName,
  });
}
