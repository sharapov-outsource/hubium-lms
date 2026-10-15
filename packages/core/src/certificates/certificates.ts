import { randomBytes } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import type { Certificate, Db, Prisma } from '@hubium/db';
import { msg } from '@hubium/module-sdk';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { requireCourseView } from '../courses/courses.ts';
import { courseLearnerIds } from '../enrol/participants.ts';
import { getEnv } from '../env.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { deleteFiles, registerFileArea, storeFile } from '../files/files.ts';
import { getStorage } from '../files/storage.ts';
import { courseGradePercent } from '../grades/course-grade.ts';
import { enqueue } from '../jobs/jobs.ts';
import { notifyUsers } from '../notifications/notifications.ts';
import { defineOperation } from '../operation.ts';
import { getAllSettings, siteLocale } from '../settings/settings.ts';
import { renderCertificatePdf } from './pdf.ts';
import {
  CertificateFields,
  type CertificateFieldT,
  type CertificateValues,
  ORIENTATIONS,
  type Orientation,
} from './template.ts';

// Course certificates, as Moodle's certificate plugins: a template the course's editing
// teachers lay out (a background and fields by coordinates), issued when a learner
// completes the course or by hand, revoked with a reason, and checked by anyone at
// /verify by the code printed on it. What an issue says (name, course, dates, grade) is
// kept as it was; the PDF is drawn from the template each time it is downloaded.

type Tx = Prisma.TransactionClient | Db;

export const CERTIFICATE_BACKGROUND_MAX_BYTES = 5 * 1024 * 1024;
export const CERTIFICATES_REVIEW_JOB = 'certificates.review';

// who manages them may see and change the background as they lay the page out
registerFileArea('certificate', 'background', (ctx, file) =>
  ctx.perm.can('certificate:manage', file.contextId),
);

async function loadCertificate(db: Tx, id: string) {
  const c = await db.certificate.findUnique({ where: { id } });
  if (!c) throw new NotFoundError('Certificate');
  return c;
}

export const fieldsOf = (c: Pick<Certificate, 'fields'>): CertificateFieldT[] =>
  CertificateFields.catch([]).parse(c.fields);

// ── codes ────────────────────────────────────────────────────────────────────

// Crockford's base32: no I, L, O or U to misread
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Twelve characters in three groups: 60 random bits. */
export function newCertificateCode(): string {
  const bytes = randomBytes(12);
  let s = '';
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** A code as typed (any case, spaces, look-alike letters) in its printed form, or null. */
export function normalizeCertificateCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 12 || [...s].some((ch) => !ALPHABET.includes(ch))) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

// ── setting up ───────────────────────────────────────────────────────────────

export const CertificateInput = z.object({
  id: z.string().uuid().optional(),
  courseId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(255),
  orientation: z.enum(ORIENTATIONS).default('landscape'),
  fields: z.unknown(),
  onCompletion: z.boolean().default(true),
});

export const saveCertificate = defineOperation({
  name: 'certificate.save',
  input: CertificateInput,
  async authorize(ctx, i) {
    const courseId = i.id ? (await loadCertificate(ctx.db, i.id)).courseId : i.courseId;
    if (!courseId) throw new ValidationError({ courseId: [msg('errors.field.required')] });
    await ctx.perm.require('certificate:manage', courseId);
  },
  async handler(ctx, input) {
    const parsed = CertificateFields.safeParse(input.fields ?? []);
    if (!parsed.success) {
      const at = parsed.error.issues[0]?.path ?? [];
      const n = typeof at[0] === 'number' ? at[0] + 1 : null;
      throw new ValidationError({
        fields: [
          n
            ? msg('errors.certificates.checkField', { n })
            : msg('errors.certificates.invalidFields'),
        ],
      });
    }
    const data = {
      name: input.name,
      orientation: input.orientation,
      fields: parsed.data as unknown as Prisma.InputJsonValue,
      onCompletion: input.onCompletion,
    };
    if (input.id) {
      await ctx.tx.certificate.update({ where: { id: input.id }, data });
      return { id: input.id };
    }
    const c = await ctx.tx.certificate.create({
      data: { ...data, courseId: input.courseId!, createdById: ctx.perm.userId },
    });
    return { id: c.id };
  },
});

/** A background is a PNG or a JPEG of at most 5 MB; which of the two it is. */
export function checkCertificateBackground(data: Uint8Array): 'png' | 'jpeg' {
  const fail = (m: string) => {
    throw new ValidationError({ background: [m] }, m);
  };
  if (data.byteLength > CERTIFICATE_BACKGROUND_MAX_BYTES) fail('The picture is larger than 5 MB');
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  return fail('Upload a PNG or JPEG picture') as never;
}

/** Sets the background picture, or removes it (no data). */
export const setCertificateBackground = defineOperation({
  name: 'certificate.background',
  input: z.object({
    id: z.string().uuid(),
    name: z.string().max(255).default(''),
    data: z.instanceof(Uint8Array).nullable(),
  }),
  authorize: async (ctx, i) =>
    ctx.perm.require('certificate:manage', (await loadCertificate(ctx.db, i.id)).courseId),
  async handler(ctx, input) {
    const c = await loadCertificate(ctx.tx, input.id);
    const kind = input.data ? checkCertificateBackground(input.data) : null;
    const where = {
      contextId: c.courseId,
      component: 'certificate',
      area: 'background',
      itemId: c.id,
    };
    await deleteFiles(ctx.tx, where);
    let fileId: string | null = null;
    if (input.data && kind) {
      const f = await storeFile(ctx.tx, {
        ...where,
        name:
          (input.name || 'background').replace(/\.[^.]*$/, '') + (kind === 'png' ? '.png' : '.jpg'),
        mimeType: kind === 'png' ? 'image/png' : 'image/jpeg',
        data: Buffer.from(input.data),
        uploadedById: ctx.perm.userId ?? null,
      });
      fileId = f.id;
    }
    await ctx.tx.certificate.update({ where: { id: c.id }, data: { backgroundFileId: fileId } });
    return { id: c.id, fileId };
  },
});

export const setCertificateStatus = defineOperation({
  name: 'certificate.status',
  input: z.object({ id: z.string().uuid(), status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']) }),
  authorize: async (ctx, i) =>
    ctx.perm.require('certificate:manage', (await loadCertificate(ctx.db, i.id)).courseId),
  async handler(ctx, { id, status }) {
    const c = await loadCertificate(ctx.tx, id);
    const fail = (m: string) => {
      throw new ValidationError({ status: [m] }, m);
    };
    if (status === 'ACTIVE' && !fieldsOf(c).length) fail('Add fields to the page first');
    if (
      status === 'DRAFT' &&
      (await ctx.tx.certificateIssue.count({ where: { certificateId: id } }))
    )
      fail('An issued certificate is archived, not made a draft');
    await ctx.tx.certificate.update({ where: { id }, data: { status } });
    // those who have completed the course already get it
    if (status === 'ACTIVE' && c.onCompletion)
      await enqueue(CERTIFICATES_REVIEW_JOB, { certificateId: id });
    await logEvent(ctx.tx, {
      name: 'certificate.status',
      actorId: ctx.perm.userId,
      courseId: c.courseId,
      data: { certificateId: id, status },
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return { id, status };
  },
});

export const deleteCertificate = defineOperation({
  name: 'certificate.delete',
  input: z.object({ id: z.string().uuid() }),
  authorize: async (ctx, i) =>
    ctx.perm.require('certificate:manage', (await loadCertificate(ctx.db, i.id)).courseId),
  async handler(ctx, { id }) {
    const c = await loadCertificate(ctx.tx, id);
    if (await ctx.tx.certificateIssue.count({ where: { certificateId: id } })) {
      const m = 'An issued certificate is archived, not deleted';
      throw new ValidationError({ id: [m] }, m);
    }
    await deleteFiles(ctx.tx, {
      contextId: c.courseId,
      component: 'certificate',
      area: 'background',
      itemId: id,
    });
    await ctx.tx.certificate.delete({ where: { id } });
    return { id };
  },
});

// ── issuing ──────────────────────────────────────────────────────────────────

/** What an issue keeps of the moment it was made. */
export interface IssueData {
  name: string;
  course: string;
  completedAt: string | null;
  gradePercent: number | null;
}

async function snapshot(tx: Tx, c: Certificate, userId: string): Promise<IssueData> {
  const [user, course, completion, gradePercent] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } }),
    tx.course.findUniqueOrThrow({ where: { id: c.courseId }, select: { fullName: true } }),
    tx.courseCompletion.findUnique({
      where: { courseId_userId: { courseId: c.courseId, userId } },
      select: { completedAt: true },
    }),
    courseGradePercent(tx, c.courseId, userId),
  ]);
  return {
    name: user.name,
    course: course.fullName,
    completedAt: completion?.completedAt?.toISOString() ?? null,
    // to a tenth, as the certificate prints it
    gradePercent: gradePercent === null ? null : Math.round(gradePercent * 10) / 10,
  };
}

async function createIssue(
  tx: Tx,
  c: Certificate,
  userId: string,
  opts: { now: Date; issuedById: string | null },
) {
  const data = (await snapshot(tx, c, userId)) as unknown as Prisma.InputJsonValue;
  // a code already taken (60 random bits: practically never) gets another
  for (let attempt = 0; ; attempt++) {
    const code = newCertificateCode();
    if (attempt < 5 && (await tx.certificateIssue.findUnique({ where: { code } }))) continue;
    const issue = await tx.certificateIssue.create({
      data: {
        certificateId: c.id,
        userId,
        code,
        issuedAt: opts.now,
        data,
        issuedById: opts.issuedById,
      },
    });
    await notifyUsers(tx, [userId], {
      type: 'certificate.issued',
      title: { key: 'notifications.text.certificateIssued', values: { name: c.name } },
      body: '',
      url: '/certificates',
      courseId: c.courseId,
      data: { certificateId: c.id, issueId: issue.id },
    });
    await logEvent(tx, {
      name: 'certificate.issued',
      actorId: opts.issuedById,
      courseId: c.courseId,
      relatedUserId: userId,
      data: { certificateId: c.id, issueId: issue.id },
    });
    return issue;
  }
}

/** Issues the certificate to a learner who has completed the course and does not have it. */
export async function issueIfEarned(
  tx: Tx,
  c: Certificate,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  if (c.status !== 'ACTIVE' || !c.onCompletion) return false;
  // a revoked certificate is not issued again by itself
  if (
    await tx.certificateIssue.findUnique({
      where: { certificateId_userId: { certificateId: c.id, userId } },
    })
  )
    return false;
  const done = await tx.courseCompletion.findUnique({
    where: { courseId_userId: { courseId: c.courseId, userId } },
    select: { completedAt: true },
  });
  if (!done?.completedAt) return false;
  if (!(await courseLearnerIds(tx, c.courseId)).includes(userId)) return false;
  await createIssue(tx, c, userId, { now, issuedById: null });
  return true;
}

/** After completion changed in a course: its certificates for the learner. */
export async function checkCourseCertificates(tx: Tx, courseId: string, userId: string) {
  const certs = await tx.certificate.findMany({
    where: { courseId, status: 'ACTIVE', onCompletion: true },
  });
  for (const c of certs) await issueIfEarned(tx, c, userId);
}

/** Issues a certificate to every learner who has completed its course; the number issued. */
export async function reviewCertificate(db: Db, certificateId: string, now = new Date()) {
  const c = await db.certificate.findUnique({ where: { id: certificateId } });
  if (c?.status !== 'ACTIVE' || !c.onCompletion) return 0;
  const done = await db.courseCompletion.findMany({
    where: { courseId: c.courseId, completedAt: { not: null } },
    select: { userId: true },
  });
  let n = 0;
  for (const { userId } of done)
    if (await db.$transaction((tx) => issueIfEarned(tx, c, userId, now))) n++;
  return n;
}

/** Issues a certificate by hand (whether or not the course is completed), or again after a revocation. */
export const issueCertificate = defineOperation({
  name: 'certificate.issue',
  input: z.object({ certificateId: z.string().uuid(), userId: z.string().uuid() }),
  authorize: async (ctx, i) =>
    ctx.perm.require(
      'certificate:issue',
      (await loadCertificate(ctx.db, i.certificateId)).courseId,
    ),
  async handler(ctx, { certificateId, userId }) {
    const c = await loadCertificate(ctx.tx, certificateId);
    if (c.status !== 'ACTIVE')
      throw new ValidationError({ certificateId: [msg('errors.certificates.notIssuing')] });
    if (!(await courseLearnerIds(ctx.tx, c.courseId)).includes(userId))
      throw new ValidationError({ userId: [msg('errors.certificates.notLearner')] });
    const old = await ctx.tx.certificateIssue.findUnique({
      where: { certificateId_userId: { certificateId, userId } },
    });
    if (old && !old.revokedAt) throw new ConflictError(msg('errors.certificates.alreadyIssued'));
    if (old) {
      // issued again: the same code is valid once more
      await ctx.tx.certificateIssue.update({
        where: { id: old.id },
        data: { revokedAt: null, revokedReason: null, issuedById: ctx.perm.userId },
      });
      await logEvent(ctx.tx, {
        name: 'certificate.restored',
        actorId: ctx.perm.userId,
        courseId: c.courseId,
        relatedUserId: userId,
        data: { certificateId, issueId: old.id },
        origin: ctx.origin,
        ip: ctx.ip,
      });
      return { id: old.id };
    }
    const issue = await createIssue(ctx.tx, c, userId, {
      now: ctx.now,
      issuedById: ctx.perm.userId ?? null,
    });
    return { id: issue.id };
  },
});

export const revokeCertificateIssue = defineOperation({
  name: 'certificate.revoke',
  input: z.object({ issueId: z.string().uuid(), reason: z.string().trim().min(1).max(500) }),
  async authorize(ctx, i) {
    const issue = await ctx.db.certificateIssue.findUnique({
      where: { id: i.issueId },
      include: { certificate: { select: { courseId: true } } },
    });
    if (!issue) throw new NotFoundError('Certificate');
    await ctx.perm.require('certificate:issue', issue.certificate.courseId);
  },
  async handler(ctx, { issueId, reason }) {
    const issue = await ctx.tx.certificateIssue.update({
      where: { id: issueId },
      data: { revokedAt: ctx.now, revokedReason: reason },
      include: { certificate: { select: { courseId: true } } },
    });
    await logEvent(ctx.tx, {
      name: 'certificate.revoked',
      actorId: ctx.perm.userId,
      courseId: issue.certificate.courseId,
      relatedUserId: issue.userId,
      data: { issueId, reason },
      origin: ctx.origin,
      ip: ctx.ip,
    });
    return { id: issueId };
  },
});

// ── reading ──────────────────────────────────────────────────────────────────

/** A course's certificates: all for those who manage them, the issued kinds for the others. */
export async function listCertificates(ctx: RequestContext, courseId: string) {
  await requireCourseView(ctx, courseId);
  const [manage, viewIssues] = await Promise.all([
    ctx.perm.can('certificate:manage', courseId),
    ctx.perm.can('certificate:viewissues', courseId),
  ]);
  const userId = ctx.perm.userId ?? '';
  const certs = await ctx.db.certificate.findMany({
    where: {
      courseId,
      ...(manage
        ? {}
        : {
            OR: [
              { status: 'ACTIVE' as const },
              { status: 'ARCHIVED' as const, issues: { some: { userId } } },
            ],
          }),
    },
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { issues: { where: { revokedAt: null } } } } },
  });
  const mine = await ctx.db.certificateIssue.findMany({
    where: { userId, certificateId: { in: certs.map((c) => c.id) } },
  });
  return {
    manage,
    viewIssues,
    certificates: certs.map((c) => ({
      ...c,
      issued: c._count.issues,
      mine: mine.find((i) => i.certificateId === c.id) ?? null,
    })),
  };
}

/** A certificate with its issues, for those who see them. */
export async function certificateDetail(ctx: RequestContext, id: string) {
  const c = await loadCertificate(ctx.db, id);
  if (!(await ctx.perm.can('certificate:viewissues', c.courseId))) throw new ForbiddenError();
  const [issues, manage, issue] = await Promise.all([
    ctx.db.certificateIssue.findMany({
      where: { certificateId: id },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { issuedAt: 'desc' },
    }),
    ctx.perm.can('certificate:manage', c.courseId),
    ctx.perm.can('certificate:issue', c.courseId),
  ]);
  const issuable =
    issue && c.status === 'ACTIVE'
      ? await ctx.db.user.findMany({
          where: {
            id: {
              in: (await courseLearnerIds(ctx.db, c.courseId)).filter(
                (u) => !issues.some((i) => i.userId === u && !i.revokedAt),
              ),
            },
          },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        })
      : [];
  return { certificate: { ...c, fields: fieldsOf(c) }, issues, manage, issue, issuable };
}

/** A person's certificates. */
export async function userCertificates(db: Tx, userId: string) {
  return db.certificateIssue.findMany({
    where: { userId },
    include: {
      certificate: {
        select: { id: true, name: true, course: { select: { id: true, fullName: true } } },
      },
    },
    orderBy: { issuedAt: 'desc' },
  });
}

/** What the verification page shows for a code; null when no certificate has it. */
export async function verifyCertificate(db: Tx, input: string) {
  const code = normalizeCertificateCode(input);
  if (!code) return null;
  const issue = await db.certificateIssue.findUnique({
    where: { code },
    include: { certificate: { select: { name: true } } },
  });
  if (!issue) return null;
  const d = issue.data as unknown as IssueData;
  return {
    code,
    certificate: issue.certificate.name,
    name: d.name,
    course: d.course,
    issuedAt: issue.issuedAt,
    completedAt: d.completedAt ? new Date(d.completedAt) : null,
    revokedAt: issue.revokedAt,
    revokedReason: issue.revokedReason,
  };
}

// ── PDF ──────────────────────────────────────────────────────────────────────

/** The address of the verification page for a code. */
export const verifyUrl = (code: string) =>
  `${getEnv().APP_URL.replace(/\/+$/, '')}/verify/${encodeURIComponent(code)}`;

async function backgroundOf(db: Tx, c: Certificate): Promise<Uint8Array | null> {
  if (!c.backgroundFileId) return null;
  const f = await db.file.findUnique({
    where: { id: c.backgroundFileId },
    include: { blob: true },
  });
  if (!f) return null;
  return new Uint8Array(await buffer(await getStorage().getStream(f.blob.storageKey)));
}

/** The issue's values, formatted in the course's language (or the site's), in the site's time zone. */
async function valuesOf(
  db: Tx,
  c: Certificate,
  d: IssueData,
  code: string,
  issuedAt: Date,
): Promise<{ values: CertificateValues; site: string }> {
  const [s, course] = await Promise.all([
    getAllSettings(db),
    db.course.findUnique({ where: { id: c.courseId }, select: { lang: true } }),
  ]);
  const locale = course?.lang || siteLocale(s);
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeZone: s['site.defaultTimezone'],
  }).format(d.completedAt ? new Date(d.completedAt) : issuedAt);
  const grade =
    d.gradePercent === null
      ? ''
      : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(
          d.gradePercent / 100,
        );
  return {
    values: { name: d.name, course: d.course, date, grade, code, url: verifyUrl(code) },
    site: s['site.name'],
  };
}

async function render(db: Tx, c: Certificate, d: IssueData, code: string, issuedAt: Date) {
  const { values, site } = await valuesOf(db, c, d, code, issuedAt);
  return renderCertificatePdf({
    orientation: (ORIENTATIONS as readonly string[]).includes(c.orientation)
      ? (c.orientation as Orientation)
      : 'landscape',
    fields: fieldsOf(c),
    values,
    background: await backgroundOf(db, c),
    title: `${c.name} — ${d.name}`,
    author: site,
    createdAt: issuedAt,
  });
}

const pdfName = (c: Certificate, who: string) =>
  `${`${c.name} ${who}`.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'certificate'}.pdf`;

/**
 * An issued certificate as a PDF, for its owner and those who see the course's issues;
 * null when there is none to give (unknown, revoked, or not theirs to see).
 */
export async function certificatePdf(ctx: RequestContext, issueId: string) {
  const issue = await ctx.db.certificateIssue.findUnique({
    where: { id: issueId },
    include: { certificate: true },
  });
  if (!issue || issue.revokedAt) return null;
  const mine = issue.userId === ctx.perm.userId;
  if (!mine && !(await ctx.perm.can('certificate:viewissues', issue.certificate.courseId)))
    return null;
  const d = issue.data as unknown as IssueData;
  return {
    data: await render(ctx.db, issue.certificate, d, issue.code, issue.issuedAt),
    name: pdfName(issue.certificate, d.name),
  };
}

/** The template filled in with the viewer's name and a sample code, for those who lay it out. */
export async function certificatePreview(ctx: RequestContext, id: string) {
  const c = await loadCertificate(ctx.db, id);
  await ctx.perm.require('certificate:manage', c.courseId);
  const [me, course] = await Promise.all([
    ctx.db.user.findUnique({ where: { id: ctx.perm.userId ?? '' }, select: { name: true } }),
    ctx.db.course.findUniqueOrThrow({ where: { id: c.courseId }, select: { fullName: true } }),
  ]);
  const d: IssueData = {
    name: me?.name ?? 'Hubium',
    course: course.fullName,
    completedAt: ctx.now.toISOString(),
    gradePercent: 95,
  };
  return { data: await render(ctx.db, c, d, '0000-0000-0000', ctx.now), name: pdfName(c, '') };
}
