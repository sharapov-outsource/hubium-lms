import { type RequestContext, ValidationError } from '@hubium/core';
import type { Prisma } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { createTranslator } from '@hubium/i18n/packs';
import { type Hint, Hints, type QuestionType, questionDataSchemas } from '@hubium/questions';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';

// Moodle XML question format: import (7 question types, category paths, base64 images,
// feedback, fractions, hints) and export of a course question bank.

type Node = Record<string, unknown>;

export interface ParsedQuestion {
  categoryPath: string[];
  type: QuestionType;
  name: string;
  text: string;
  generalFeedback: string;
  defaultMark: number;
  penalty: number;
  /** For the interactive behaviour: shown between tries. */
  hints: Hint[];
  data: unknown;
  idNumber: string | null;
  tags: string[];
}

export interface ParseResult {
  questions: ParsedQuestion[];
  errors: { name: string; message: string }[];
}

const arr = <T>(v: T | T[] | undefined): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
const txt = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  const n = v as Node;
  if ('text' in n) return txt(n.text);
  if ('#text' in n) return txt(n['#text']);
  return '';
};
const num = (v: unknown, d = 0) => {
  const n = Number(txt(v));
  return Number.isFinite(n) ? n : d;
};

/** Replaces @@PLUGINFILE@@/<name> with data: URIs from embedded <file> elements. */
function inlineFiles(html: string, holder: Node | undefined): string {
  if (!holder) return html;
  const files = arr(holder.file as Node | Node[]);
  let out = html;
  for (const f of files) {
    const name = String(f['@_name'] ?? '');
    const data = txt(f).replace(/\s+/g, '');
    if (!name || f['@_encoding'] !== 'base64' || !data) continue;
    const ext = name.toLowerCase().split('.').pop();
    const mime =
      ext === 'png'
        ? 'image/png'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'webp'
            ? 'image/webp'
            : 'image/jpeg';
    out = out
      .split(`@@PLUGINFILE@@/${encodeURIComponent(name)}`)
      .join(`data:${mime};base64,${data}`);
    out = out.split(`@@PLUGINFILE@@/${name}`).join(`data:${mime};base64,${data}`);
  }
  return out;
}

const html = (field: unknown) => {
  const n = (field ?? {}) as Node;
  const raw = inlineFiles(txt(n), n);
  return n['@_format'] === 'plain_text' || n['@_format'] === 'moodle_auto_format'
    ? raw
        .split(/\r?\n/)
        .map((l) => l.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!))
        .join('<br>')
    : raw;
};

const plain = (h: string) =>
  h
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

/** <hint> elements: their text, and <clearwrong/> and <shownumcorrect/> when present. */
function readHints(v: unknown): Hint[] {
  const hints = arr(v as Node | Node[])
    .filter((h) => h && typeof h === 'object')
    .map((h) => ({
      text: sanitizeRichText(html(h)),
      clearWrong: 'clearwrong' in h,
      showNumCorrect: 'shownumcorrect' in h,
    }))
    .filter((h) => plain(h.text) || h.text.includes('<img'));
  return Hints.parse(hints.slice(0, 10));
}

function mapQuestion(q: Node, path: string[], untitled: string): ParsedQuestion | null {
  const qtype = String(q['@_type']);
  const name = plain(txt(q.name)) || untitled;
  const base = {
    categoryPath: path,
    name: name.slice(0, 255),
    text: sanitizeRichText(html(q.questiontext)),
    generalFeedback: sanitizeRichText(html(q.generalfeedback)),
    defaultMark: num(q.defaultgrade, 1),
    penalty: Math.min(1, Math.max(0, num(q.penalty, 0))),
    hints: readHints(q.hint),
    idNumber: txt(q.idnumber) || null,
    tags: arr((q.tags as Node | undefined)?.tag as Node | Node[])
      .map((t) => txt(t))
      .filter(Boolean),
  };
  const answers = arr(q.answer as Node | Node[]);
  const fraction = (a: Node) => num(a['@_fraction']) / 100;
  switch (qtype) {
    case 'multichoice':
      return {
        ...base,
        type: 'MULTICHOICE',
        data: {
          single: txt(q.single) !== 'false' && txt(q.single) !== '0',
          shuffleAnswers: txt(q.shuffleanswers) !== '0' && txt(q.shuffleanswers) !== 'false',
          answers: answers.map((a, i) => ({
            id: `a${i + 1}`,
            text: sanitizeRichText(html(a)) || `#${i + 1}`,
            fraction: fraction(a),
            feedback: sanitizeRichText(html(a.feedback)),
          })),
        },
      };
    case 'truefalse': {
      const t = answers.find((a) => plain(txt(a)).toLowerCase() === 'true');
      const f = answers.find((a) => plain(txt(a)).toLowerCase() === 'false');
      return {
        ...base,
        type: 'TRUEFALSE',
        data: {
          correct: t ? fraction(t) > 0 : false,
          feedbackTrue: t ? sanitizeRichText(html(t.feedback)) : '',
          feedbackFalse: f ? sanitizeRichText(html(f.feedback)) : '',
        },
      };
    }
    case 'shortanswer':
      return {
        ...base,
        type: 'SHORTANSWER',
        data: {
          caseSensitive: txt(q.usecase) === '1',
          answers: answers
            .filter((a) => fraction(a) > 0)
            .map((a) => ({
              text: plain(txt(a)),
              fraction: fraction(a),
              feedback: sanitizeRichText(html(a.feedback)),
            })),
        },
      };
    case 'numerical':
      return {
        ...base,
        type: 'NUMERICAL',
        data: {
          answers: answers
            .filter((a) => fraction(a) > 0 && plain(txt(a)) !== '*')
            .map((a) => ({
              value: Number(plain(txt(a))),
              tolerance: num(a.tolerance, 0),
              fraction: fraction(a),
              feedback: sanitizeRichText(html(a.feedback)),
            })),
        },
      };
    case 'matching': {
      const subs = arr(q.subquestion as Node | Node[]);
      const pairs = subs
        .filter((s) => plain(txt(s)))
        .map((s, i) => ({
          id: `p${i + 1}`,
          question: plain(html(s)),
          answer: plain(txt(arr(s.answer as Node | Node[])[0])),
        }));
      const distractors = subs
        .filter((s) => !plain(txt(s)))
        .map((s) => plain(txt(arr(s.answer as Node | Node[])[0])))
        .filter(Boolean);
      return {
        ...base,
        type: 'MATCH',
        data: { shuffle: txt(q.shuffleanswers) !== '0', pairs, distractors },
      };
    }
    case 'essay':
      return {
        ...base,
        type: 'ESSAY',
        data: {
          minWords: num(q.minwordlimit, 0),
          maxWords: num(q.maxwordlimit, 0),
          graderInfo: sanitizeRichText(html(q.graderinfo)),
        },
      };
    case 'description':
      return { ...base, defaultMark: 0, type: 'DESCRIPTION', data: {} };
    default:
      return null;
  }
}

/** Parses Moodle XML; category entries set the path for the questions that follow. */
/** `untitled` names questions that have no name of their own. */
export function parseMoodleXml(xml: string, untitled = 'Question'): ParseResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => ['question', 'answer', 'subquestion', 'file', 'tag'].includes(name),
  });
  const doc = parser.parse(xml) as Node;
  const quiz = doc.quiz as Node | undefined;
  if (!quiz) throw new ValidationError({ file: ['Not a Moodle XML file: <quiz> is missing'] });
  const out: ParseResult = { questions: [], errors: [] };
  let path: string[] = [];
  for (const q of arr(quiz.question as Node | Node[])) {
    if (q['@_type'] === 'category') {
      path = txt(q.category)
        .split('/')
        .map((s) => s.trim())
        .filter((s) => s && !/^\$\w+\$$/.test(s) && s !== 'top');
      continue;
    }
    const name = plain(txt(q.name)) || String(q['@_type']);
    try {
      const mapped = mapQuestion(q, path, untitled);
      if (!mapped) {
        out.errors.push({ name, message: `Unsupported question type: ${q['@_type']}` });
        continue;
      }
      const schema = questionDataSchemas[mapped.type];
      const parsed = schema.safeParse(mapped.data);
      if (!parsed.success) {
        out.errors.push({ name, message: parsed.error.issues[0]?.message ?? 'Invalid question' });
        continue;
      }
      out.questions.push({ ...mapped, data: parsed.data });
    } catch (e) {
      out.errors.push({ name, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** Imports Moodle XML into a course bank, creating categories from the paths. */
export async function importMoodleXml(ctx: RequestContext, courseId: string, xml: string) {
  await ctx.perm.require('question:manage', courseId);
  const t = createTranslator(ctx.locale);
  const parsed = parseMoodleXml(xml, t('qbank.untitledQuestion'));
  const cache = new Map<string, string>();
  const ensurePath = async (tx: Prisma.TransactionClient, path: string[]) => {
    let parentId: string | null = null;
    let key = '';
    for (const name of path.length ? path : [t('qbank.importedCategory')]) {
      key += `/${name}`;
      let id = cache.get(key);
      if (!id) {
        const found: { id: string } | null = await tx.questionCategory.findFirst({
          where: { contextId: courseId, parentId, name },
          select: { id: true },
        });
        id =
          found?.id ??
          (await tx.questionCategory.create({ data: { contextId: courseId, parentId, name } })).id;
        cache.set(key, id);
      }
      parentId = id;
    }
    return parentId!;
  };
  await ctx.db.$transaction(async (tx) => {
    for (const q of parsed.questions) {
      const categoryId = await ensurePath(tx, q.categoryPath);
      await tx.question.create({
        data: {
          categoryId,
          type: q.type,
          name: q.name,
          text: q.text,
          generalFeedback: q.generalFeedback,
          defaultMark: q.defaultMark,
          penalty: q.penalty,
          hints: q.hints as unknown as Prisma.InputJsonValue,
          data: q.data as Prisma.InputJsonValue,
          idNumber: q.idNumber,
          tags: q.tags,
          source: 'IMPORT',
          createdById: ctx.perm.userId ?? null,
        },
      });
    }
  });
  return { created: parsed.questions.length, errors: parsed.errors };
}

// ── export ───────────────────────────────────────────────────────────────────

const cdata = (s: string) => ({ text: { '#cdata': s } });

function exportQuestion(q: {
  type: string;
  name: string;
  text: string;
  generalFeedback: string;
  defaultMark: unknown;
  penalty: unknown;
  data: unknown;
  idNumber: string | null;
}): Node | null {
  const head: Node = {
    name: { text: q.name },
    questiontext: { '@_format': 'html', ...cdata(q.text) },
    generalfeedback: { '@_format': 'html', ...cdata(q.generalFeedback) },
    defaultgrade: String(Number(q.defaultMark)),
    penalty: String(Number(q.penalty)),
    hidden: '0',
    ...(q.idNumber ? { idnumber: q.idNumber } : {}),
  };
  const pct = (f: number) => String(Math.round(f * 1e7) / 1e5);
  const type = q.type as QuestionType;
  switch (type) {
    case 'MULTICHOICE': {
      const d = q.data as {
        single: boolean;
        shuffleAnswers: boolean;
        answers: { text: string; fraction: number; feedback: string }[];
      };
      return {
        '@_type': 'multichoice',
        ...head,
        single: d.single ? 'true' : 'false',
        shuffleanswers: d.shuffleAnswers ? 'true' : 'false',
        answernumbering: 'abc',
        answer: d.answers.map((a) => ({
          '@_fraction': pct(a.fraction),
          '@_format': 'html',
          ...cdata(a.text),
          feedback: { '@_format': 'html', ...cdata(a.feedback) },
        })),
      };
    }
    case 'TRUEFALSE': {
      const d = q.data as { correct: boolean; feedbackTrue: string; feedbackFalse: string };
      return {
        '@_type': 'truefalse',
        ...head,
        answer: [
          {
            '@_fraction': d.correct ? '100' : '0',
            '@_format': 'moodle_auto_format',
            text: 'true',
            feedback: { '@_format': 'html', ...cdata(d.feedbackTrue) },
          },
          {
            '@_fraction': d.correct ? '0' : '100',
            '@_format': 'moodle_auto_format',
            text: 'false',
            feedback: { '@_format': 'html', ...cdata(d.feedbackFalse) },
          },
        ],
      };
    }
    case 'SHORTANSWER': {
      const d = q.data as {
        caseSensitive: boolean;
        answers: { text: string; fraction: number; feedback: string }[];
      };
      return {
        '@_type': 'shortanswer',
        ...head,
        usecase: d.caseSensitive ? '1' : '0',
        answer: d.answers.map((a) => ({
          '@_fraction': pct(a.fraction),
          '@_format': 'moodle_auto_format',
          text: a.text,
          feedback: { '@_format': 'html', ...cdata(a.feedback) },
        })),
      };
    }
    case 'NUMERICAL': {
      const d = q.data as {
        answers: { value: number; tolerance: number; fraction: number; feedback: string }[];
      };
      return {
        '@_type': 'numerical',
        ...head,
        answer: d.answers.map((a) => ({
          '@_fraction': pct(a.fraction),
          '@_format': 'moodle_auto_format',
          text: String(a.value),
          tolerance: String(a.tolerance),
          feedback: { '@_format': 'html', ...cdata(a.feedback) },
        })),
      };
    }
    case 'MATCH': {
      const d = q.data as {
        shuffle: boolean;
        pairs: { question: string; answer: string }[];
        distractors: string[];
      };
      return {
        '@_type': 'matching',
        ...head,
        shuffleanswers: d.shuffle ? 'true' : 'false',
        subquestion: [
          ...d.pairs.map((p) => ({
            '@_format': 'html',
            ...cdata(p.question),
            answer: { text: p.answer },
          })),
          ...d.distractors.map((x) => ({ '@_format': 'html', text: '', answer: { text: x } })),
        ],
      };
    }
    case 'ESSAY': {
      const d = q.data as { minWords: number; maxWords: number; graderInfo: string };
      return {
        '@_type': 'essay',
        ...head,
        responseformat: 'editor',
        responserequired: '1',
        responsefieldlines: '15',
        minwordlimit: String(d.minWords || ''),
        maxwordlimit: String(d.maxWords || ''),
        graderinfo: { '@_format': 'html', ...cdata(d.graderInfo) },
      };
    }
    case 'DESCRIPTION':
      return { '@_type': 'description', ...head };
    default: {
      // every question type needs a branch here: this stops the build otherwise
      const missing: never = type;
      return missing;
    }
  }
}

function hintNodes(hints: unknown): Node {
  const list = Hints.catch([]).parse(hints);
  return list.length
    ? {
        hint: list.map((h) => ({
          '@_format': 'html',
          ...cdata(h.text),
          ...(h.showNumCorrect ? { shownumcorrect: '' } : {}),
          ...(h.clearWrong ? { clearwrong: '' } : {}),
        })),
      }
    : {};
}

/** Exports a course question bank (or one category with subcategories) as Moodle XML. */
export async function exportMoodleXml(
  ctx: RequestContext,
  courseId: string,
  categoryId?: string,
): Promise<string> {
  await ctx.perm.require('question:manage', courseId);
  const cats = await ctx.db.questionCategory.findMany({
    where: { contextId: courseId },
    orderBy: { sortOrder: 'asc' },
  });
  const byId = new Map(cats.map((c) => [c.id, c]));
  const pathOf = (id: string): string[] => {
    const c = byId.get(id);
    return c ? [...(c.parentId ? pathOf(c.parentId) : []), c.name] : [];
  };
  const within = (id: string): boolean =>
    !categoryId ||
    id === categoryId ||
    (!!byId.get(id)?.parentId && within(byId.get(id)!.parentId!));
  const qs = await ctx.db.question.findMany({
    where: {
      categoryId: { in: cats.filter((c) => within(c.id)).map((c) => c.id) },
      status: { not: 'HIDDEN' },
    },
    orderBy: [{ categoryId: 'asc' }, { createdAt: 'asc' }],
  });
  const items: Node[] = [];
  let lastCat = '';
  for (const q of qs) {
    if (q.categoryId !== lastCat) {
      lastCat = q.categoryId;
      items.push({
        '@_type': 'category',
        category: { text: `$course$/top/${pathOf(q.categoryId).join('/')}` },
      });
    }
    const x = exportQuestion(q);
    if (x) items.push({ ...x, ...hintNodes(q.hints) });
  }
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    cdataPropName: '#cdata',
    format: true,
    suppressEmptyNode: false,
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({ quiz: { question: items } })}`;
}
