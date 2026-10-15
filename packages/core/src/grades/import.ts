import type { Prisma } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { z } from 'zod';
import type { MutationContext } from '../context.ts';
import { ValidationError } from '../errors.ts';
import { logEvent } from '../events/log.ts';
import { readSheet } from '../lib/sheets.ts';
import { defineOperation } from '../operation.ts';
import { parseCsv } from '../users/users.ts';
import {
  gradeLocked,
  decimalToNumber as num,
  recomputeCourseTotals,
  writeGrade,
} from './gradebook.ts';
import { scaleValue } from './scales.ts';

// Importing grades from a spreadsheet (CSV, XLSX or ODS), as Moodle's import: the first
// row names the columns, one column finds the student (email or username), the others
// map to an item's grade or feedback. The same plan is shown as a preview and applied;
// nothing is kept between the two (the file comes again with the mapping). A manual item
// gets the grade itself; an activity's item an override, as a teacher's change in the
// grader report would.

type Tx = Prisma.TransactionClient;

export const GradeImportMapping = z.object({
  /** The column (0-based) that finds the student, and by what. */
  userColumn: z.number().int().min(0),
  userField: z.enum(['email', 'username']),
  columns: z
    .array(
      z.object({
        column: z.number().int().min(0),
        itemId: z.string().uuid(),
        what: z.enum(['grade', 'feedback']),
      }),
    )
    .max(200),
});
export type GradeImportMapping = z.output<typeof GradeImportMapping>;

/** Items a sheet can fill: those graded by points or a scale, not totals or formulas. */
async function importTargets(tx: Tx, courseId: string) {
  return tx.gradeItem.findMany({
    where: {
      courseId,
      kind: { in: ['MANUAL', 'MODULE'] },
      gradeType: { in: ['VALUE', 'SCALE'] },
      calculation: null,
      OR: [{ activityId: null }, { activity: { deletedAt: null } }],
    },
    include: { scale: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

/** A mapping guessed from the header: the email/username column and items by name or ID. */
export function suggestMapping(
  header: string[],
  items: { id: string; name: string; idNumber: string | null }[],
): GradeImportMapping {
  const norm = (s: string) => s.trim().toLowerCase();
  const find = (...names: string[]) => header.findIndex((h) => names.includes(norm(h)));
  const email = find('email', 'e-mail', 'адрес электронной почты', 'email address', 'почта');
  const username = find('username', 'логин', 'имя пользователя');
  const columns: GradeImportMapping['columns'] = [];
  for (const [column, h] of header.entries()) {
    const key = norm(h);
    if (!key || column === email || column === username) continue;
    // "Item (feedback)" / "Item: отзыв" carry the feedback
    const feedback = /\s*[:(]\s*(feedback|отзыв)\)?$/i;
    const name = key.replace(feedback, '');
    const item = items.find(
      (i) => norm(i.name) === name || (i.idNumber && norm(i.idNumber) === name),
    );
    if (item)
      columns.push({ column, itemId: item.id, what: feedback.test(key) ? 'feedback' : 'grade' });
  }
  return {
    userColumn: email >= 0 ? email : Math.max(0, username),
    userField: email >= 0 || username < 0 ? 'email' : 'username',
    columns,
  };
}

export interface ImportRow {
  /** The row of the sheet, 1-based (the header is row 1). */
  line: number;
  key: string;
  user: { id: string; name: string } | null;
  changes: { itemId: string; grade?: number; feedback?: string }[];
  errors: string[];
  /** The errors for the interface to word: what is wrong, and with which item and value. */
  problems: { code: 'noKey' | 'noStudent' | 'notAGrade'; item?: string; value: string }[];
}

/** What importing the rows would do, row by row, with the problems found. */
export async function planGradeImport(
  tx: Tx,
  courseId: string,
  rows: string[][],
  mapping: GradeImportMapping,
) {
  const items = await importTargets(tx, courseId);
  const seen = new Set<string>();
  for (const c of mapping.columns) {
    if (!items.some((i) => i.id === c.itemId))
      throw new ValidationError({
        mapping: ['A column is mapped to an item that cannot be imported'],
      });
    if (seen.has(`${c.itemId}:${c.what}`))
      throw new ValidationError({ mapping: ['Two columns are mapped to the same thing'] });
    seen.add(`${c.itemId}:${c.what}`);
  }
  const body = rows.slice(1);
  const keys = [
    ...new Set(body.map((r) => (r[mapping.userColumn] ?? '').trim().toLowerCase()).filter(Boolean)),
  ];
  const enrolled = await tx.user.findMany({
    where: {
      enrolments: { some: { courseId } },
      deletedAt: null,
      [mapping.userField]: { in: keys, mode: 'insensitive' },
    },
    select: { id: true, name: true, email: true, username: true },
  });
  const byKey = new Map(
    enrolled.map((u) => [
      ((mapping.userField === 'email' ? u.email : u.username) ?? '').toLowerCase(),
      u,
    ]),
  );
  const out: ImportRow[] = [];
  for (const [n, r] of body.entries()) {
    if (!r.some((x) => x.trim())) continue;
    const key = (r[mapping.userColumn] ?? '').trim();
    const u = byKey.get(key.toLowerCase());
    const row: ImportRow = {
      line: n + 2,
      key,
      user: u ? { id: u.id, name: u.name } : null,
      changes: [],
      errors: [],
      problems: [],
    };
    if (!u) {
      row.errors.push(key ? `No student in the course: ${key}` : 'No email or username');
      row.problems.push({ code: key ? 'noStudent' : 'noKey', value: key });
    }
    for (const c of mapping.columns) {
      const cell = (r[c.column] ?? '').trim();
      if (cell === '') continue;
      const item = items.find((i) => i.id === c.itemId)!;
      let change = row.changes.find((x) => x.itemId === item.id);
      if (!change) row.changes.push((change = { itemId: item.id }));
      if (c.what === 'feedback') {
        change.feedback = cell.slice(0, 10_000);
        continue;
      }
      // scale grades by their name (as exported) or position; points with , or .
      const v = item.scale ? scaleValue(item.scale.items, cell) : Number(cell.replace(',', '.'));
      if (v === null || Number.isNaN(v) || v < num(item.gradeMin)! || v > num(item.gradeMax)!) {
        row.errors.push(`${item.name}: not a grade: ${cell}`);
        row.problems.push({ code: 'notAGrade', item: item.name, value: cell });
      } else change.grade = v;
    }
    row.changes = row.changes.filter((x) => x.grade !== undefined || x.feedback !== undefined);
    out.push(row);
  }
  return {
    rows: out,
    totals: {
      students: out.filter((r) => r.user).length,
      grades: out.reduce((s, r) => s + (r.user ? r.changes.length : 0), 0),
      errors: out.reduce((s, r) => s + r.errors.length, 0),
    },
  };
}

const FileInput = {
  courseId: z.string().uuid(),
  data: z.instanceof(Uint8Array),
};

/**
 * The first step of an import: the sheet's header and first rows, a mapping (the one
 * given, or one guessed from the header), the items it can fill and what it would do.
 */
export const previewGradeImport = defineOperation({
  name: 'grade.import.preview',
  input: z.object({ ...FileInput, mapping: GradeImportMapping.optional() }),
  authorize: (ctx, i) => ctx.perm.require('grade:import', i.courseId),
  async handler(ctx, { courseId, data, mapping }) {
    const rows = readSheet(data);
    const header = rows[0] ?? [];
    if (!header.length) throw new ValidationError({ file: ['The sheet is empty'] });
    const items = await importTargets(ctx.tx, courseId);
    const m = mapping ?? suggestMapping(header, items);
    const plan = await planGradeImport(ctx.tx, courseId, rows, m);
    return {
      header,
      /** The first row under the header, to recognise the columns by. */
      sample: rows.slice(1).find((r) => r.length) ?? [],
      mapping: m,
      items: items.map((i) => ({ id: i.id, name: i.name, kind: i.kind })),
      rows: plan.rows.slice(0, 20),
      problems: plan.rows
        .filter((r) => r.errors.length)
        .slice(0, 50)
        .map((r) => ({ line: r.line, problems: r.problems })),
      totals: plan.totals,
    };
  },
});

/** The second step: the plan applied, rows and cells with problems left out. */
export const applyGradeImport = defineOperation({
  name: 'grade.import.apply',
  input: z.object({ ...FileInput, mapping: GradeImportMapping }),
  authorize: (ctx, i) => ctx.perm.require('grade:import', i.courseId),
  async handler(ctx, { courseId, data, mapping }) {
    return applyRows(ctx, courseId, readSheet(data), mapping);
  },
});

async function applyRows(
  ctx: MutationContext,
  courseId: string,
  rows: string[][],
  mapping: GradeImportMapping,
) {
  const { tx } = ctx;
  const plan = await planGradeImport(tx, courseId, rows, mapping);
  const items = await importTargets(tx, courseId);
  const changedById = ctx.perm.userId;
  let updated = 0;
  const touched = new Set<string>();
  // locked grades keep their value: said for each, rather than counted as updated
  const locked: { line: number; message: string }[] = [];
  for (const r of plan.rows) {
    if (!r.user) continue;
    for (const c of r.changes) {
      const item = items.find((i) => i.id === c.itemId)!;
      if (await gradeLocked(tx, item, r.user.id)) {
        locked.push({ line: r.line, message: `The grade of “${item.name}” is locked` });
        continue;
      }
      const feedback = c.feedback === undefined ? undefined : sanitizeRichText(c.feedback);
      // a manual item takes the grade; an activity's item an override of it
      const values =
        c.grade === undefined
          ? { feedback }
          : item.kind === 'MANUAL'
            ? { rawGrade: c.grade, feedback }
            : { finalGrade: c.grade, overridden: true, feedback };
      await writeGrade(tx, item, r.user.id, values, { source: 'import', changedById });
      updated++;
      touched.add(r.user.id);
    }
  }
  await recomputeCourseTotals(tx, courseId, [...touched]);
  await logEvent(tx, {
    name: 'grade.imported',
    actorId: changedById,
    courseId,
    origin: ctx.origin,
  });
  return {
    updated,
    errors: [
      ...plan.rows.flatMap((r) => r.errors.map((message) => ({ line: r.line, message }))),
      ...locked,
    ].sort((a, b) => a.line - b.line),
  };
}

/**
 * The CSV import of earlier versions: the header names manual items, and an email or a
 * username column finds the student.
 */
export const importGradesCsv = defineOperation({
  name: 'grade.import',
  input: z.object({ courseId: z.string().uuid(), csv: z.string().min(1).max(5_000_000) }),
  authorize: (ctx, i) => ctx.perm.require('grade:import', i.courseId),
  async handler(ctx, { courseId, csv }) {
    const rows = parseCsv(csv);
    const header = rows[0] ?? [];
    const has = (n: string) => header.some((h) => h.trim().toLowerCase() === n);
    if (!has('email') && !has('username'))
      throw new ValidationError({ csv: ['Header must contain email or username'] });
    const manual = (await importTargets(ctx.tx, courseId)).filter((i) => i.kind === 'MANUAL');
    const mapping = suggestMapping(header, manual);
    if (!mapping.columns.length)
      throw new ValidationError({ csv: ['No columns match manual grade items'] });
    // empty lines were dropped by the parser: rows keep their CSV order
    return applyRows(ctx, courseId, rows, mapping);
  },
});
