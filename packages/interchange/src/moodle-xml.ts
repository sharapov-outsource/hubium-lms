import { type RequestContext, ValidationError } from '@hubium/core';
import type { Prisma } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { createTranslator } from '@hubium/i18n/packs';
import { msg } from '@hubium/module-sdk';
import {
  checkQuestionText,
  checkVariants,
  type Dataset,
  datasetFromRow,
  type Hint,
  Hints,
  type QuestionType,
  questionDataFrom,
  questionDataSchemas,
} from '@hubium/questions';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import {
  answerFormat,
  datasetFromOptions,
  orderingGrading,
  orderingGradingName,
  orderingLayout,
  orderingNumbering,
  orderingSelect,
  orderingShowGrading,
  toleranceType,
  toleranceTypeNumber,
  UNITS_LEFT_OUT,
} from './moodle-qtypes.ts';

// Moodle XML question format: import (11 question types, category paths, base64 images,
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
  /** Calculated questions: datasets their category shares (made unless already there). */
  sharedDatasets?: Dataset[];
  data: unknown;
  idNumber: string | null;
  tags: string[];
}

export interface ParseResult {
  questions: ParsedQuestion[];
  /** Questions left out, and why. */
  errors: { name: string; message: string }[];
  /** Questions imported with something left out. */
  warnings: { name: string; message: string }[];
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
    case 'ordering': {
      // the answers come in the right order
      const select = txt(q.selecttype ?? q.logical) || 'RANDOM';
      return {
        ...base,
        type: 'ORDERING',
        data: {
          items: answers
            .map((a, i) => ({ id: `i${i + 1}`, text: plain(html(a)) }))
            .filter((i) => i.text),
          grading: orderingGrading(txt(q.gradingtype) || 'RELATIVE'),
          select: orderingSelect(select),
          selectCount: Math.max(2, num(q.selectcount ?? q.studentsee, 6)),
          layout: orderingLayout(txt(q.layouttype)),
          numbering: orderingNumbering(txt(q.numberingstyle)),
          showGrading: orderingShowGrading(txt(q.showgrading) || 'SHOW'),
          ...combinedFeedback(q),
        },
      };
    }
    case 'gapselect': {
      // modern files list <selectoption>s; old ones answers with the group as feedback
      const options = arr(q.selectoption as Node | Node[]);
      const choices = options.length
        ? options.map((o, i) => ({ id: `c${i + 1}`, text: plain(txt(o)), group: num(o.group, 1) }))
        : answers.map((a, i) => ({
            id: `c${i + 1}`,
            text: plain(txt(a)),
            group: num(txt(a.feedback), 1),
          }));
      return {
        ...base,
        type: 'GAPSELECT',
        data: { shuffle: txt(q.shuffleanswers) !== '0', choices, ...combinedFeedback(q) },
      };
    }
    case 'ddwtos':
      return {
        ...base,
        type: 'DDWTOS',
        data: {
          shuffle: txt(q.shuffleanswers) !== '0',
          choices: arr(q.dragbox as Node | Node[]).map((d, i) => ({
            id: `c${i + 1}`,
            text: plain(txt(d)),
            group: num(d.group, 1),
            infinite: 'infinite' in d,
          })),
          ...combinedFeedback(q),
        },
      };
    case 'calculated':
    case 'calculatedsimple':
    case 'calculatedmulti': {
      const defs = arr(
        (q.dataset_definitions as Node | undefined)?.dataset_definition as Node | Node[],
      ).map((d) => ({
        shared: txt(d.status).trim() === 'shared',
        set: datasetFromOptions(
          plain(txt(d.name)),
          `${txt(d.distribution) || 'uniform'}:${txt(d.minimum)}:${txt(d.maximum)}:${txt(d.decimals)}`,
          arr((d.dataset_items as Node | undefined)?.dataset_item as Node | Node[])
            .sort((a, b) => num(a.number) - num(b.number))
            .map((i) => num(i.value)),
        ),
      }));
      const shared = qtype === 'calculatedsimple' ? [] : defs.filter((d) => d.shared);
      const format = (a: Node) => ({
        format: answerFormat(txt(a.correctanswerformat)),
        length: Math.min(9, num(a.correctanswerlength, 2)),
      });
      const datasets = {
        datasets: defs.filter((d) => !shared.includes(d)).map((d) => d.set),
        ...(qtype === 'calculatedsimple'
          ? {}
          : { shared: shared.map((d) => d.set.name), synchronize: txt(q.synchronize) === '1' }),
      };
      return {
        ...base,
        type:
          qtype === 'calculatedmulti'
            ? 'CALCULATEDMULTI'
            : qtype === 'calculatedsimple'
              ? 'CALCULATEDSIMPLE'
              : 'CALCULATED',
        sharedDatasets: shared.map((d) => d.set),
        data:
          qtype === 'calculatedmulti'
            ? {
                single: txt(q.single) !== '0' && txt(q.single) !== 'false',
                shuffleAnswers: txt(q.shuffleanswers) !== '0' && txt(q.shuffleanswers) !== 'false',
                answers: answers.map((a, i) => ({
                  id: `a${i + 1}`,
                  text: plain(html(a)),
                  fraction: fraction(a),
                  feedback: sanitizeRichText(html(a.feedback)),
                  ...format(a),
                })),
                ...datasets,
              }
            : {
                answers: answers.map((a) => ({
                  formula: plain(txt(a)),
                  fraction: Math.max(0, fraction(a)),
                  tolerance: Math.abs(num(a.tolerance, 0.01)),
                  toleranceType: toleranceType(txt(a.tolerancetype)),
                  feedback: sanitizeRichText(html(a.feedback)),
                  ...format(a),
                })),
                ...datasets,
              },
      };
    }
    case 'cloze':
      // the gaps are written in the text, as in Hubium
      return {
        ...base,
        type: 'MULTIANSWER',
        data: questionDataFrom('MULTIANSWER', base.text, null),
      };
    default:
      return null;
  }
}

/** Feedback for right, partly right and wrong responses. */
function combinedFeedback(q: Node) {
  return {
    feedbackCorrect: sanitizeRichText(html(q.correctfeedback)),
    feedbackPartial: sanitizeRichText(html(q.partiallycorrectfeedback)),
    feedbackIncorrect: sanitizeRichText(html(q.incorrectfeedback)),
  };
}

/** Parses Moodle XML; category entries set the path for the questions that follow. */
/** `untitled` names questions that have no name of their own. */
export function parseMoodleXml(xml: string, untitled = 'Question'): ParseResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
    isArray: (name) =>
      ['question', 'answer', 'subquestion', 'file', 'tag', 'selectoption', 'dragbox'].includes(
        name,
      ),
  });
  const doc = parser.parse(xml) as Node;
  const quiz = doc.quiz as Node | undefined;
  if (!quiz) throw new ValidationError({ file: [msg('errors.interchange.notMoodleXml')] });
  const out: ParseResult = { questions: [], errors: [], warnings: [] };
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
      if (mapped.type === 'MULTIANSWER') {
        const clozeError = checkQuestionText(mapped.type, mapped.text, mapped.data);
        if (clozeError) {
          out.errors.push({ name, message: clozeError });
          continue;
        }
      }
      const schema = questionDataSchemas[mapped.type];
      const parsed = schema.safeParse(mapped.data);
      if (!parsed.success) {
        out.errors.push({ name, message: parsed.error.issues[0]?.message ?? 'Invalid question' });
        continue;
      }
      // gaps in the text must match the choices (a Cloze text, its answers)
      const textError =
        checkQuestionText(mapped.type, mapped.text, parsed.data) ??
        (mapped.type.startsWith('CALCULATED')
          ? checkVariants(
              mapped.type as 'CALCULATED',
              mapped.text,
              parsed.data as never,
              mapped.sharedDatasets ?? [],
            )
          : null);
      if (textError) {
        out.errors.push({ name, message: textError });
        continue;
      }
      if (q.units && String(q['@_type']).startsWith('calculated'))
        out.warnings.push({ name, message: UNITS_LEFT_OUT });
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
      // a dataset the category already shares under that name is kept as it is
      for (const d of q.sharedDatasets ?? [])
        await tx.questionDataset.upsert({
          where: { categoryId_name: { categoryId, name: d.name } },
          create: {
            categoryId,
            name: d.name,
            min: d.min,
            max: d.max,
            decimals: d.decimals,
            distribution: d.distribution === 'loguniform' ? 'LOGUNIFORM' : 'UNIFORM',
            items: d.items,
          },
          update: {},
        });
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
  return { created: parsed.questions.length, errors: parsed.errors, warnings: parsed.warnings };
}

// ── export ───────────────────────────────────────────────────────────────────

const cdata = (s: string) => ({ text: { '#cdata': s } });
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Combined = { feedbackCorrect: string; feedbackPartial: string; feedbackIncorrect: string };
const combinedNodes = (d: Combined): Node => ({
  correctfeedback: { '@_format': 'html', ...cdata(d.feedbackCorrect) },
  partiallycorrectfeedback: { '@_format': 'html', ...cdata(d.feedbackPartial) },
  incorrectfeedback: { '@_format': 'html', ...cdata(d.feedbackIncorrect) },
});

function exportQuestion(
  q: {
    type: string;
    name: string;
    text: string;
    generalFeedback: string;
    defaultMark: unknown;
    penalty: unknown;
    data: unknown;
    idNumber: string | null;
  },
  shared: Dataset[] = [],
): Node | null {
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
    case 'ORDERING': {
      const d = q.data as {
        items: { text: string }[];
        grading: Parameters<typeof orderingGradingName>[0];
        select: string;
        selectCount: number;
        layout: string;
        numbering: string;
        showGrading: boolean;
      } & Combined;
      return {
        '@_type': 'ordering',
        ...head,
        layouttype: d.layout.toUpperCase(),
        selecttype: d.select.toUpperCase(),
        selectcount: String(d.select === 'all' ? d.items.length : d.selectCount),
        gradingtype: orderingGradingName(d.grading),
        showgrading: d.showGrading ? 'SHOW' : 'HIDE',
        numberingstyle: d.numbering,
        ...combinedNodes(d),
        answer: d.items.map((it, i) => ({
          '@_fraction': String(i + 1),
          '@_format': 'html',
          ...cdata(escapeHtml(it.text)),
        })),
      };
    }
    case 'MULTIANSWER':
      // the text holds the gaps
      return { '@_type': 'cloze', ...head };
    case 'CALCULATED':
    case 'CALCULATEDSIMPLE':
    case 'CALCULATEDMULTI': {
      const d = q.data as {
        single?: boolean;
        shuffleAnswers?: boolean;
        answers: {
          formula?: string;
          text?: string;
          fraction: number;
          tolerance?: number;
          toleranceType?: 'relative' | 'nominal' | 'geometric';
          format: 'decimals' | 'significant';
          length: number;
          feedback: string;
        }[];
        datasets: Dataset[];
        shared?: string[];
        synchronize?: boolean;
      };
      const definition = (set: Dataset, status: 'private' | 'shared') => ({
        status: { text: status },
        name: { text: set.name },
        type: 'calculated',
        distribution: { text: set.distribution },
        minimum: { text: String(set.min) },
        maximum: { text: String(set.max) },
        decimals: { text: String(set.decimals) },
        itemcount: String(set.items.length),
        dataset_items: {
          dataset_item: set.items.map((v, i) => ({ number: String(i + 1), value: String(v) })),
        },
        number_of_items: String(set.items.length),
      });
      const sharedSets = shared.filter((s) => d.shared?.includes(s.name));
      return {
        '@_type': type.toLowerCase(),
        ...head,
        synchronize: d.synchronize ? '1' : '0',
        single: d.single === false ? '0' : '1',
        answernumbering: 'abc',
        shuffleanswers: d.shuffleAnswers === false ? '0' : '1',
        answer: d.answers.map((a) => ({
          '@_fraction': pct(a.fraction),
          ...(type === 'CALCULATEDMULTI'
            ? { '@_format': 'html', ...cdata(a.text ?? '') }
            : {
                text: a.formula ?? '',
                tolerance: String(a.tolerance ?? 0.01),
                tolerancetype: toleranceTypeNumber(a.toleranceType ?? 'relative'),
              }),
          correctanswerformat: a.format === 'significant' ? '2' : '1',
          correctanswerlength: String(a.length),
          feedback: { '@_format': 'html', ...cdata(a.feedback) },
        })),
        dataset_definitions: {
          dataset_definition: [
            ...d.datasets.map((s) => definition(s, 'private')),
            ...sharedSets.map((s) => definition(s, 'shared')),
          ],
        },
      };
    }
    case 'GAPSELECT':
    case 'DDWTOS': {
      const d = q.data as {
        shuffle: boolean;
        choices: { text: string; group: number; infinite?: boolean }[];
      } & Combined;
      const drag = type === 'DDWTOS';
      return {
        '@_type': drag ? 'ddwtos' : 'gapselect',
        ...head,
        shuffleanswers: d.shuffle ? '1' : '0',
        ...combinedNodes(d),
        [drag ? 'dragbox' : 'selectoption']: d.choices.map((c) => ({
          text: c.text,
          group: String(c.group),
          ...(drag && c.infinite ? { infinite: '' } : {}),
        })),
      };
    }
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
  // datasets the categories share, for calculated questions
  const shared = new Map<string, Dataset[]>();
  for (const r of await ctx.db.questionDataset.findMany({
    where: { categoryId: { in: [...new Set(qs.map((q) => q.categoryId))] } },
  }))
    shared.set(r.categoryId, [...(shared.get(r.categoryId) ?? []), datasetFromRow(r)]);
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
    const x = exportQuestion(q, shared.get(q.categoryId) ?? []);
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
