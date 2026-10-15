import { Readable } from 'node:stream';
import {
  buildModuleCtx,
  type CourseField,
  calculationOrder,
  calculationRefs,
  createCourse,
  disabledTypesIn,
  disabledTypesWarning,
  ensureCourseGradebook,
  foreignCourseValues,
  getModule,
  importActivity,
  listCourseFields,
  type RequestContext,
  toActivityRef,
  ValidationError,
} from '@hubium/core';
import { fileUrl, storeFile } from '@hubium/core/files/files';
import type { Prisma } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { createTranslator } from '@hubium/i18n/packs';
import { Guide, Rubric } from '@hubium/module-sdk/grading';
import { invalidIpListEntries } from '@hubium/module-sdk/net';
import {
  type ClozePart,
  checkQuestionText,
  checkVariants,
  type Dataset,
  type Hint,
  Hints,
  type QuestionType,
  questionDataFrom,
  questionDataSchemas,
  toClozeSource,
} from '@hubium/questions';
import { XMLParser } from 'fast-xml-parser';
import tar from 'tar-stream';
import {
  ARCHIVE_LIMITS,
  type ArchiveLimits,
  archiveTooLarge,
  gunzipLimited,
  unzipLimited,
} from './archive.ts';
import { addMissingSections, discardCourse } from './hubium.ts';
import {
  answerFormat,
  datasetFromOptions,
  ddwtosOptions,
  orderingGrading,
  orderingLayout,
  orderingNumbering,
  orderingSelect,
  orderingShowGrading,
  toleranceType,
  UNITS_LEFT_OUT,
} from './moodle-qtypes.ts';

// Moodle course backup (.mbz) import for Moodle 4.1–5.x: course, sections, the common
// activities, question bank and files. Anything unsupported becomes a label and is
// listed in the report.

type Node = Record<string, unknown>;

/**
 * Moodle course custom fields, for the fields this site has under the same short names:
 * a menu value is the option's number, a date a timestamp, a text area HTML.
 */
function mbzCourseFields(courseXml: Node, fields: CourseField[]) {
  const raw: Record<string, unknown> = {};
  for (const c of arr(((courseXml.customfields ?? {}) as Node).customfield as Node | Node[])) {
    const f = fields.find((x) => x.shortName === txt(c.shortname).toLowerCase());
    if (!f) continue;
    const value = txt(c.value);
    const type = txt(c.type);
    raw[f.shortName] =
      type === 'select'
        ? (f.choices[Number(value) - 1] ?? value)
        : type === 'date'
          ? Number(value) > 0
            ? // midnight where it was set, whatever the time zone
              new Date((Number(value) + 43_200) * 1000).toISOString().slice(0, 10)
            : ''
          : type === 'textarea'
            ? value
                .replace(/<[^>]*>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
            : value;
  }
  return foreignCourseValues(fields, raw);
}
const arr = <T>(v: T | T[] | undefined): T[] =>
  v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v];
const txt = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    const s = String(v);
    return s === '$@NULL@$' ? '' : s;
  }
  if (typeof v === 'object' && '#text' in (v as Node)) return txt((v as Node)['#text']);
  return '';
};
// an empty value is a missing one: it takes the default, not 0
const num = (v: unknown, d = 0) => {
  const s = txt(v).trim();
  const n = Number(s);
  return s !== '' && Number.isFinite(n) ? n : d;
};
const date = (v: unknown) => {
  const n = num(v);
  return n > 0 ? new Date(n * 1000).toISOString() : null;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
  isArray: (name) =>
    [
      'activity',
      'section',
      'file',
      'question_category',
      'question_bank_entry',
      'question_version',
      'question',
      'answer',
      'match',
      'numerical_record',
      'question_instance',
    ].includes(name),
});

export type Archive = Map<string, Buffer>;

/** Reads a .mbz: gzip'ed tar (Moodle ≥ 2.6 default) or zip (older or "zip" setting). */
export async function readMbz(
  buf: Buffer,
  limits: ArchiveLimits = ARCHIVE_LIMITS,
): Promise<Archive> {
  const files =
    buf[0] === 0x50 && buf[1] === 0x4b
      ? readZip(buf, limits)
      : await readTar(
          buf[0] === 0x1f && buf[1] === 0x8b ? gunzipLimited(buf, limits) : buf,
          limits,
        );
  if (!files.has('moodle_backup.xml'))
    throw new ValidationError({ file: ['Not a Moodle backup: moodle_backup.xml is missing'] });
  return files;
}

function readZip(buf: Buffer, limits: ArchiveLimits): Archive {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipLimited(new Uint8Array(buf), limits);
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError({ file: ['The archive is damaged'] });
  }
  const files: Archive = new Map();
  for (const [k, v] of Object.entries(entries)) files.set(k.replace(/^\.\//, ''), Buffer.from(v));
  return files;
}

// The tar body is never larger than the (size-capped) gunzipped input, so only entries are counted.
async function readTar(raw: Buffer, limits: ArchiveLimits): Promise<Archive> {
  const files: Archive = new Map();
  const extract = tar.extract();
  let count = 0;
  await new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      if (++count > limits.entries) {
        extract.destroy();
        return reject(archiveTooLarge());
      }
      const chunks: Buffer[] = [];
      stream.on('data', (c: unknown) => chunks.push(c as Buffer));
      stream.on('end', () => {
        if (header.type === 'file')
          files.set(header.name.replace(/^\.\//, ''), Buffer.concat(chunks));
        next();
      });
      stream.resume();
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
    Readable.from([raw]).pipe(extract);
  });
  return files;
}

/** Root element of a file (roots like <activity>/<section> are parsed as arrays). */
const root = (doc: Node | null, name: string): Node =>
  (arr(doc?.[name] as Node | Node[])[0] ?? {}) as Node;

const xml = (a: Archive, path: string): Node | null => {
  const b = a.get(path);
  return b ? (parser.parse(b.toString('utf8')) as Node) : null;
};

interface MbzFile {
  contenthash: string;
  contextid: string;
  component: string;
  filearea: string;
  itemid: string;
  filepath: string;
  filename: string;
  mimetype: string;
}

export interface MbzReport {
  courseId: string;
  moodleRelease: string;
  sections: number;
  activities: number;
  questions: number;
  files: number;
  warnings: string[];
}

// ── questions ────────────────────────────────────────────────────────────────

/** A question's hints (question_hints) for the interactive behaviour. */
function mbzHints(q: Node): Hint[] {
  const list = arr((q.question_hints as Node | undefined)?.question_hint as Node | Node[])
    .map((h) => ({
      text: sanitizeRichText(txt(h.hint)),
      clearWrong: txt(h.clearwrong) === '1',
      showNumCorrect: txt(h.shownumcorrect) === '1',
    }))
    .filter((h) => h.text.trim());
  return Hints.parse(list.slice(0, 10));
}

/** Moodle review option bit: "during the attempt". */
const DURING = 0x10000;

/**
 * The quiz's question behaviour. Certainty-based marking is not supported (its plain
 * behaviour is used) and adaptive mode becomes interactive: both are reported.
 */
export function quizBehaviour(data: Node, warn: (why: string) => void) {
  const b = txt(data.preferredbehaviour);
  const behaviour =
    b === 'immediatefeedback' || b === 'immediatecbm'
      ? 'immediate'
      : b === 'interactive' || b === 'adaptive' || b === 'adaptivenopenalty'
        ? 'interactive'
        : 'deferred';
  if (b.endsWith('cbm')) warn('certainty-based marking is not supported: plain marking is used');
  if (b.startsWith('adaptive'))
    warn('adaptive mode is imported as interactive with multiple tries');
  const during = (field: unknown, d: boolean) =>
    txt(field) === '' ? d : (num(field) & DURING) !== 0;
  return {
    behaviour,
    duringFeedback: during(data.reviewspecificfeedback, true),
    duringRightAnswer: during(data.reviewrightanswer, false),
  };
}

type Mapped = {
  type: QuestionType;
  data: unknown;
  /** Calculated: datasets shared in a Moodle category (its id), and units left out. */
  shared?: { category: string; set: Dataset }[];
  unitsLeftOut?: boolean;
};

/** A calculated question of any kind, with its datasets. */
const AGGREGATIONS: Record<
  string,
  'MEAN' | 'MEDIAN' | 'LOWEST' | 'HIGHEST' | 'WEIGHTED_MEAN' | 'NATURAL'
> = {
  '0': 'MEAN',
  '2': 'MEDIAN',
  '4': 'LOWEST',
  '6': 'HIGHEST',
  '10': 'WEIGHTED_MEAN',
  '13': 'NATURAL',
};

/**
 * Moodle's aggregation of a grade category as Hubium's. Those Hubium lacks (mode, simple
 * weighted mean, mean with extra credit) come as the nearest, and are reported.
 */
export function gradeAggregation(code: string, warn: (why: string) => void) {
  const a = AGGREGATIONS[code];
  if (a) return a;
  const near = code === '11' ? ('WEIGHTED_MEAN' as const) : ('MEAN' as const);
  warn(`grade category aggregation ${code} is not available: ${near} is used`);
  return near;
}

/** The text of a Moodle HTML field, for fields that are plain text here. */
const fieldText = (v: unknown) =>
  txt(v)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim();

/** The first value under a key anywhere below a node (plugin wrappers differ by version). */
function below(n: unknown, key: string): Node | undefined {
  if (!n || typeof n !== 'object') return undefined;
  for (const [k, v] of Object.entries(n as Node)) {
    if (k === key) return v as Node;
    const inner = Array.isArray(v) ? v.map((x) => below(x, key)).find(Boolean) : below(v, key);
    if (inner) return inner;
  }
  return undefined;
}

const sortorder = (a: Node, b: Node) => num(a.sortorder) - num(b.sortorder);

/**
 * An assignment's active rubric or marking guide from its grading.xml, as Hubium defines
 * them (criteria and levels keep Moodle's ids). null without one.
 */
export function mbzGradingForm(
  doc: Node | null,
): { method: 'rubric' | 'guide'; definition: unknown } | null {
  const areas = arr(((doc?.areas ?? {}) as Node).area as Node | Node[]);
  const area = areas.find((a) => txt(a.areaname) === 'submissions') ?? areas[0];
  const method = txt(area?.activemethod);
  if (method !== 'rubric' && method !== 'guide') return null;
  const def = arr(((area!.definitions ?? {}) as Node).definition as Node | Node[]).find(
    (d) => txt(d.method) === method,
  );
  if (!def) return null;
  if (method === 'rubric') {
    let options: { lockzeropoints?: string | number } = {};
    try {
      options = JSON.parse(txt(def.options) || '{}');
    } catch {}
    const criteria = arr(below(def, 'criteria')?.criterion as Node | Node[]).sort(sortorder);
    return {
      method,
      definition: {
        criteria: criteria.map((c, i) => ({
          id: `c${String(c['@_id'] ?? i)}`,
          description: fieldText(c.description).slice(0, 2000) || `${i + 1}`,
          levels: arr(below(c, 'levels')?.level as Node | Node[]).map((l, k) => ({
            id: `l${String(l['@_id'] ?? k)}`,
            score: num(l.score),
            definition: fieldText(l.definition).slice(0, 2000),
          })),
        })),
        lockZeroPoints: String(options.lockzeropoints ?? '1') !== '0',
      },
    };
  }
  const criteria = arr(below(def, 'guidecriteria')?.guidecriterion as Node | Node[]).sort(
    sortorder,
  );
  return {
    method,
    definition: {
      criteria: criteria.map((c, i) => ({
        id: `g${String(c['@_id'] ?? i)}`,
        shortName: fieldText(c.shortname).slice(0, 255) || `${i + 1}`,
        descriptionStudents: fieldText(c.description).slice(0, 2000),
        descriptionMarkers: fieldText(c.descriptionmarkers).slice(0, 2000),
        maxScore: num(c.maxscore, 1),
      })),
    },
  };
}

/**
 * Moodle's assignment settings as Hubium's: what can be submitted (the submission plugins'
 * settings), dates, grade or scale, reopening, the statement, teams, the marking workflow,
 * allocation and blind marking.
 */
export function mbzAssignSettings(data: Node, scaleOf: (moodleId: string) => string | undefined) {
  const cfg = new Map(
    arr(((data.plugin_configs ?? {}) as Node).plugin_config as Node | Node[]).map((c) => [
      `${txt(c.subtype)}/${txt(c.plugin)}/${txt(c.name)}`,
      txt(c.value),
    ]),
  );
  const has = (k: string) => cfg.has(k);
  const on = (k: string, d: boolean) => (has(k) ? cfg.get(k) === '1' : d);
  const grade = num(data.grade, 100);
  const scaleId = grade < 0 ? (scaleOf(String(-grade)) ?? null) : null;
  const bytes = num(cfg.get('assignsubmission/file/maxsubmissionsizebytes'));
  const reopen = txt(data.attemptreopenmethod);
  const allowText = on('assignsubmission/onlinetext/enabled', true);
  const allowFiles = on('assignsubmission/file/enabled', true);
  return {
    openAt: date(data.allowsubmissionsfromdate),
    dueAt: date(data.duedate),
    cutoffAt: date(data.cutoffdate),
    gradeMax: grade > 0 ? grade : 100,
    scaleId,
    submitButton: txt(data.submissiondrafts) === '1',
    // at least one way to hand in work
    allowText: allowText || !allowFiles,
    allowFiles,
    maxFiles: Math.min(
      20,
      Math.max(1, num(cfg.get('assignsubmission/file/maxfilesubmissions'), 5)),
    ),
    maxFileMB: bytes > 0 ? Math.min(500, Math.max(1, Math.ceil(bytes / 1024 / 1024))) : 20,
    wordLimit: on('assignsubmission/onlinetext/wordlimitenabled', false)
      ? Math.max(0, num(cfg.get('assignsubmission/onlinetext/wordlimit')))
      : 0,
    reopen: reopen === 'manual' || reopen === 'untilpass' ? reopen : 'none',
    maxAttempts: Math.max(0, num(data.maxattempts, -1)),
    requireStatement: txt(data.requiresubmissionstatement) === '1',
    teamSubmission: txt(data.teamsubmission) === '1',
    requireAllTeamMembers: txt(data.requireallteammemberssubmit) === '1',
    preventSubmissionNotInGroup: txt(data.preventsubmissionnotingroup) === '1',
    markingWorkflow: txt(data.markingworkflow) === '1',
    markingAllocation: txt(data.markingallocation) === '1',
    blindMarking: txt(data.blindmarking) === '1',
  };
}

/**
 * Moodle's forum ratings and whole-forum grade as Hubium's: the aggregate, points or a
 * scale (a negative scale is a scale's id), the window of posts that can be rated.
 */
export function mbzForumGrading(data: Node, scaleOf: (moodleId: string) => string | undefined) {
  const aggregates = ['none', 'average', 'count', 'max', 'min', 'sum'] as const;
  const scale = num(data.scale);
  const whole = num(data.grade_forum);
  return {
    ratingAggregate: aggregates[num(data.assessed)] ?? 'none',
    ratingMax: scale > 0 ? Math.min(100, Math.round(scale)) : 10,
    ratingScaleId: scale < 0 ? (scaleOf(String(-scale)) ?? null) : null,
    ratingFrom: date(data.assesstimestart),
    ratingTo: date(data.assesstimefinish),
    wholeForumGrading: whole !== 0,
    gradeMax: whole > 0 ? whole : 100,
    gradeScaleId: whole < 0 ? (scaleOf(String(-whole)) ?? null) : null,
  };
}

/** Every node named `tag` anywhere under `node` (subplugin data nests in varying wrappers). */
function nodesNamed(node: unknown, tag: string): Node[] {
  if (!node || typeof node !== 'object') return [];
  const out: Node[] = [];
  for (const [k, v] of Object.entries(node as Node)) {
    if (k === tag) out.push(...arr(v as Node | Node[]));
    else for (const x of arr(v as Node | Node[])) out.push(...nodesNamed(x, tag));
  }
  return out;
}

/**
 * An H5P activity's settings. Moodle's display options are H5P's "disable" bits (1 the
 * action bar, 8 the rights of use); its grading methods are numbered 0 (none) to 4.
 */
export function mbzH5pSettings(data: Node) {
  const display = num(data.displayoptions, 0);
  const method = num(data.grademethod, 1);
  const grade = num(data.grade, 100);
  return {
    settings: {
      tracking: txt(data.enabletracking) !== '0',
      gradeMethod:
        (['HIGHEST', 'HIGHEST', 'AVERAGE', 'LAST', 'FIRST'] as const)[method] ?? 'HIGHEST',
      gradeMax: grade > 0 ? grade : 100,
      showFrame: (display & 1) === 0,
      showCopyright: (display & 8) === 0,
    },
    manual: method === 0,
    onScale: grade < 0,
    attempts: arr(((data.attempts ?? {}) as Node).attempt as Node | Node[]).length,
  };
}

/**
 * A Moodle workshop's settings and its assessment form, as the workshop module's backup
 * takes them; submissions and assessments are users' data and stay out.
 */
export function mbzWorkshop(data: Node) {
  const presence = (v: unknown) =>
    (['off', 'optional', 'required'] as const)[num(v, 1)] ?? 'optional';
  const strategy = (['accumulative', 'comments', 'numerrors', 'rubric'] as const).find(
    (k) => k === txt(data.strategy),
  );
  const sorted = (xs: Node[]) => [...xs].sort((a, b) => num(a.sort) - num(b.sort));
  const comparison = num(nodesNamed(data, 'workshopeval_best_setting')[0]?.comparison, 5);
  let onScale = false;
  const dimensions = !strategy
    ? []
    : strategy === 'accumulative'
      ? sorted(nodesNamed(data, 'workshopform_accumulative_dimension')).map((d) => {
          const g = num(d.grade, 10);
          if (g < 0) onScale = true;
          return {
            description: txt(d.description),
            maxGrade: g > 0 ? g : 10,
            weight: num(d.weight, 1),
          };
        })
      : strategy === 'comments'
        ? sorted(nodesNamed(data, 'workshopform_comments_dimension')).map((d) => ({
            description: txt(d.description),
          }))
        : strategy === 'numerrors'
          ? sorted(nodesNamed(data, 'workshopform_numerrors_dimension')).map((d) => ({
              description: txt(d.description),
              weight: num(d.weight, 1),
              positive: plainText(txt(d.grade1)).slice(0, 255) || undefined,
              negative: plainText(txt(d.grade0)).slice(0, 255) || undefined,
            }))
          : sorted(nodesNamed(data, 'workshopform_rubric_criterion')).map((c) => ({
              description: txt(c.description),
              levels: nodesNamed(c, 'workshopform_rubric_level')
                .sort((a, b) => num(a.grade) - num(b.grade))
                .map((l) => ({
                  grade: num(l.grade),
                  definition: plainText(txt(l.definition)).slice(0, 2000),
                })),
            }));
  const mapping = Object.fromEntries(
    nodesNamed(data, 'workshopform_numerrors_map').map((m) => [txt(m.nonegative), num(m.grade)]),
  );
  const ws = num(data.grade, 80);
  const wg = num(data.gradinggrade, 20);
  return {
    settings: {
      strategy: strategy ?? 'accumulative',
      gradeMax: ws >= 0 ? ws : 80,
      gradingGradeMax: wg >= 0 ? wg : 20,
      instructAuthors: txt(data.instructauthors),
      instructReviewers: txt(data.instructreviewers),
      conclusion: txt(data.conclusion),
      submissionText: presence(data.submissiontypetext),
      submissionFiles:
        num(data.nattachments, 1) === 0 ? ('off' as const) : presence(data.submissiontypefile),
      maxAttachments: Math.min(20, Math.max(0, num(data.nattachments, 1))),
      lateSubmissions: txt(data.latesubmissions) === '1',
      submissionStart: date(data.submissionstart),
      submissionEnd: date(data.submissionend),
      assessmentStart: date(data.assessmentstart),
      assessmentEnd: date(data.assessmentend),
      phaseSwitch: txt(data.phaseswitchassessment) === '1',
      selfAssessment: txt(data.useselfassessment) === '1',
      comparison: [9, 7, 5, 3, 1].includes(comparison) ? comparison : 5,
    },
    form: strategy && dimensions.length ? { [strategy]: { dimensions, mapping } } : {},
    unknownStrategy: !strategy,
    onScale,
    examples: txt(data.useexamples) === '1',
    submissions: nodesNamed(data, 'submission').length,
  };
}

/** Moodle's lesson page kinds (qtype) as Hubium's. */
const LESSON_QTYPES: Record<string, string> = {
  '1': 'shortanswer',
  '2': 'truefalse',
  '3': 'multichoice',
  '5': 'matching',
  '8': 'numerical',
  '10': 'essay',
  '20': 'content',
  '21': 'endofbranch',
  '30': 'cluster',
  '31': 'endofcluster',
};
/** Moodle's jump constants (positive numbers are page ids). */
const LESSON_JUMPS: Record<string, string> = {
  '0': 'this',
  '-1': 'next',
  '-9': 'end',
  '-40': 'previous',
  '-50': 'unseenBranch',
  '-60': 'randomBranch',
  '-70': 'randomContent',
  '-80': 'unseenCluster',
};

/**
 * A Moodle lesson's pages in reading order (they form a linked list), as the lesson
 * module's backup takes them: jumps to pages name the pages' Moodle ids. `contents`
 * gives a page's text with its files stored.
 */
export async function mbzLessonPages(
  data: Node,
  contents: (pageId: string, html: string) => Promise<string>,
) {
  const all = arr(((data.pages ?? {}) as Node).page as Node | Node[]);
  const byId = new Map(all.map((p) => [String(p['@_id']), p]));
  const ordered: Node[] = [];
  let cur = all.find((p) => num(p.prevpageid) === 0);
  while (cur && !ordered.includes(cur)) {
    ordered.push(cur);
    cur = byId.get(txt(cur.nextpageid));
  }
  // a broken chain: the rest in id order
  for (const p of [...all].sort((x, y) => num(x['@_id']) - num(y['@_id'])))
    if (!ordered.includes(p)) ordered.push(p);
  const skipped = new Set<string>();
  const pages = [];
  for (const p of ordered) {
    const type = LESSON_QTYPES[txt(p.qtype)];
    if (!type) {
      skipped.add(txt(p.qtype));
      continue;
    }
    const answers = arr(((p.answers ?? {}) as Node).answer as Node | Node[]);
    const jump = (a: Node) => {
      const j = txt(a.jumpto);
      return LESSON_JUMPS[j] ?? (num(j) > 0 && byId.has(j) ? j : 'next');
    };
    const row = (a: Node, text = plainText(txt(a.answer_text))) => ({
      text: text.slice(0, 2000),
      response: plainText(txt(a.response)).slice(0, 5000),
      jump: jump(a),
      score: num(a.score),
    });
    const id = String(p['@_id']);
    const base = {
      key: id,
      type,
      title: (plainText(txt(p.title)) || '—').slice(0, 255),
      contents:
        type.startsWith('endof') || type === 'cluster' ? '' : await contents(id, txt(p.contents)),
    };
    if (type === 'matching') {
      const [ok, ko, ...rest] = answers;
      pages.push({
        ...base,
        answers: [ok, ko].filter(Boolean).map((a) => row(a!, '')),
        options: {
          pairs: rest
            .map((a) => ({
              left: plainText(txt(a.answer_text)).slice(0, 2000),
              right: plainText(txt(a.response)).slice(0, 2000),
            }))
            .filter((x) => x.left && x.right),
        },
      });
      continue;
    }
    const single = type === 'essay' || type === 'endofbranch' || type.includes('cluster');
    pages.push({
      ...base,
      answers: (single ? answers.slice(0, 1) : answers).map((a) =>
        single ? { ...row(a, ''), response: type === 'essay' ? row(a).response : '' } : row(a),
      ),
      options:
        type === 'content'
          ? { horizontal: txt(p.layout) === '1', inMenu: txt(p.display) !== '0' }
          : type === 'multichoice'
            ? { multiple: txt(p.qoption) === '1' }
            : type === 'shortanswer'
              ? { caseSensitive: txt(p.qoption) === '1' }
              : {},
    });
  }
  return { pages, skipped: [...skipped] };
}

/** A Moodle lesson's settings as Hubium's lesson's. */
export function mbzLessonSettings(data: Node) {
  const grade = num(data.grade, 0);
  const limit = num(data.timelimit);
  return {
    practice: txt(data.practice) === '1',
    gradeMax: grade > 0 ? Math.min(1000, grade) : grade < 0 ? 100 : 0,
    customScoring: txt(data.custom) !== '0',
    retake: txt(data.retake) === '1',
    useMaxGrade: txt(data.usemaxgrade) === '1',
    maxAttempts: Math.min(10, Math.max(1, num(data.maxattempts, 1) || 1)),
    minQuestions: Math.min(100, Math.max(0, num(data.minquestions))),
    review: txt(data.review) === '1',
    feedback: txt(data.feedback) === '1',
    ongoing: txt(data.ongoing) === '1',
    progressBar: txt(data.progressbar) === '1',
    displayMenu: txt(data.displayleft) === '1',
    timeLimitMin: limit > 0 ? Math.min(1440, Math.max(1, Math.round(limit / 60))) : undefined,
    opensAt: date(data.available),
    closesAt: date(data.deadline),
  };
}

function mapCalculated(qtype: string, plugin: Node, answers: Node[]): Mapped {
  const records = arr(
    (plugin.calculated_records as Node | undefined)?.calculated_record as Node | Node[],
  );
  const options =
    arr((plugin.calculated_options as Node | undefined)?.calculated_option as Node | Node[])[0] ??
    {};
  const defs = arr(
    (plugin.dataset_definitions as Node | undefined)?.dataset_definition as Node | Node[],
  ).map((d) => ({
    category: txt(d.category),
    set: datasetFromOptions(
      txt(d.name),
      txt(d.options),
      arr((d.dataset_items as Node | undefined)?.dataset_item as Node | Node[])
        .sort((a, b) => num(a.number ?? a.itemnumber) - num(b.number ?? b.itemnumber))
        .map((i) => num(i.value)),
    ),
  }));
  const shared =
    qtype === 'calculatedsimple' ? [] : defs.filter((d) => d.category && d.category !== '0');
  // "answer" is read as a list everywhere in a backup, so here too
  const recordOf = (a: Node) =>
    records.find((r) => txt(arr(r.answer as Node | Node[])[0]) === String(a['@_id'])) ?? {};
  const format = (r: Node) => ({
    format: answerFormat(txt(r.correctanswerformat)),
    length: Math.min(9, num(r.correctanswerlength, 2)),
  });
  const datasets = {
    datasets: defs.filter((d) => !shared.includes(d)).map((d) => d.set),
    ...(qtype === 'calculatedsimple'
      ? {}
      : { shared: shared.map((d) => d.set.name), synchronize: txt(options.synchronize) === '1' }),
  };
  const fb = (a: Node) => sanitizeRichText(txt(a.feedback));
  return {
    type:
      qtype === 'calculatedmulti'
        ? 'CALCULATEDMULTI'
        : qtype === 'calculatedsimple'
          ? 'CALCULATEDSIMPLE'
          : 'CALCULATED',
    shared,
    unitsLeftOut: !!(plugin.numerical_units as Node | undefined)?.numerical_unit,
    data:
      qtype === 'calculatedmulti'
        ? {
            single: txt(options.single) !== '0',
            shuffleAnswers: txt(options.shuffleanswers) !== '0',
            answers: answers.map((a, i) => ({
              id: `a${i + 1}`,
              text: plainText(txt(a.answertext)),
              fraction: num(a.fraction),
              feedback: fb(a),
              ...format(recordOf(a)),
            })),
            ...datasets,
          }
        : {
            answers: answers.map((a) => ({
              formula: plainText(txt(a.answertext)),
              fraction: Math.max(0, num(a.fraction)),
              tolerance: Math.abs(num(recordOf(a).tolerance, 0.01)),
              toleranceType: toleranceType(txt(recordOf(a).tolerancetype)),
              feedback: fb(a),
              ...format(recordOf(a)),
            })),
            ...datasets,
          },
  };
}

function mapMoodleQuestion(q: Node): Mapped | null {
  const qtype = txt(q.qtype);
  const plugin = (q[`plugin_qtype_${qtype}_question`] ?? {}) as Node;
  const answers = arr((plugin.answers as Node | undefined)?.answer as Node | Node[]);
  const fb = (a: Node) => sanitizeRichText(txt(a.feedback));
  switch (qtype) {
    case 'multichoice': {
      const opts = (plugin.multichoice ?? {}) as Node;
      return {
        type: 'MULTICHOICE',
        data: {
          single: txt(opts.single) !== '0',
          shuffleAnswers: txt(opts.shuffleanswers) !== '0',
          answers: answers.map((a, i) => ({
            id: `a${i + 1}`,
            text: sanitizeRichText(txt(a.answertext)) || `#${i + 1}`,
            fraction: num(a.fraction),
            feedback: fb(a),
          })),
        },
      };
    }
    case 'truefalse': {
      const tf = (plugin.truefalse ?? {}) as Node;
      const t = answers.find((a) => a['@_id'] === txt(tf.trueanswer)) ?? answers[0];
      const f = answers.find((a) => a['@_id'] === txt(tf.falseanswer)) ?? answers[1];
      return {
        type: 'TRUEFALSE',
        data: {
          correct: t ? num(t.fraction) > 0 : true,
          feedbackTrue: t ? fb(t) : '',
          feedbackFalse: f ? fb(f) : '',
        },
      };
    }
    case 'shortanswer':
      return {
        type: 'SHORTANSWER',
        data: {
          caseSensitive: txt((plugin.shortanswer as Node | undefined)?.usecase) === '1',
          answers: answers
            .filter((a) => num(a.fraction) > 0)
            .map((a) => ({
              text: txt(a.answertext).replace(/<[^>]+>/g, ''),
              fraction: num(a.fraction),
              feedback: fb(a),
            })),
        },
      };
    case 'numerical': {
      const records = arr(
        (plugin.numerical_records as Node | undefined)?.numerical_record as Node | Node[],
      );
      return {
        type: 'NUMERICAL',
        data: {
          answers: answers
            .filter((a) => num(a.fraction) > 0 && txt(a.answertext) !== '*')
            .map((a) => ({
              value: num(a.answertext),
              tolerance: num(records.find((r) => txt(r.answer) === a['@_id'])?.tolerance, 0),
              fraction: num(a.fraction),
              feedback: fb(a),
            })),
        },
      };
    }
    case 'match': {
      const matches = arr((plugin.matches as Node | undefined)?.match as Node | Node[]);
      const plain = (s: string) =>
        s
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      return {
        type: 'MATCH',
        data: {
          shuffle: txt((plugin.matchoptions as Node | undefined)?.shuffleanswers) !== '0',
          pairs: matches
            .filter((m) => plain(txt(m.questiontext)))
            .map((m, i) => ({
              id: `p${i + 1}`,
              question: plain(txt(m.questiontext)),
              answer: plain(txt(m.answertext)),
            })),
          distractors: matches
            .filter((m) => !plain(txt(m.questiontext)))
            .map((m) => plain(txt(m.answertext))),
        },
      };
    }
    case 'essay': {
      const e = (plugin.essay ?? {}) as Node;
      return {
        type: 'ESSAY',
        data: {
          minWords: num(e.minwordlimit, 0),
          maxWords: num(e.maxwordlimit, 0),
          graderInfo: sanitizeRichText(txt(e.graderinfo)),
        },
      };
    }
    case 'description':
      return { type: 'DESCRIPTION', data: {} };
    case 'calculated':
    case 'calculatedsimple':
    case 'calculatedmulti':
      return mapCalculated(qtype, plugin, answers);
    case 'ordering': {
      const o = (plugin.ordering ?? {}) as Node;
      return {
        type: 'ORDERING',
        data: {
          // an answer's fraction is its place in the right order
          items: [...answers]
            .sort((a, b) => num(a.fraction) - num(b.fraction))
            .map((a, i) => ({ id: `i${i + 1}`, text: plainText(txt(a.answertext)) }))
            .filter((i) => i.text),
          grading: orderingGrading(txt(o.gradingtype) || '1'),
          select: orderingSelect(txt(o.selecttype) || '0'),
          selectCount: Math.max(2, num(o.selectcount, 6)),
          layout: orderingLayout(txt(o.layouttype)),
          numbering: orderingNumbering(txt(o.numberingstyle)),
          showGrading: orderingShowGrading(txt(o.showgrading) || '1'),
          ...combinedFeedback(o),
        },
      };
    }
    case 'gapselect':
    case 'ddwtos': {
      const o = (plugin[qtype] ?? {}) as Node;
      return {
        type: qtype === 'ddwtos' ? 'DDWTOS' : 'GAPSELECT',
        data: {
          shuffle: txt(o.shuffleanswers) !== '0',
          choices: answers.map((a, i) => {
            // the group is kept in the answer's feedback (serialised with "unlimited" for ddwtos)
            const opts =
              qtype === 'ddwtos'
                ? ddwtosOptions(txt(a.feedback))
                : { group: num(a.feedback, 1) || 1, infinite: false };
            return {
              id: `c${i + 1}`,
              text: plainText(txt(a.answertext)),
              group: opts.group,
              ...(qtype === 'ddwtos' ? { infinite: opts.infinite } : {}),
            };
          }),
          ...combinedFeedback(o),
        },
      };
    }
    default:
      return null;
  }
}

/**
 * A Cloze question's text with its gaps written back in ({#1} → {1:SA:=…}) from the
 * questions in its sequence; null when a gap is of a type Cloze cannot hold.
 */
function clozeText(q: Node, byId: Map<string, Node>): string | null {
  const ma = ((q.plugin_qtype_multianswer_question as Node | undefined)?.multianswer ?? {}) as Node;
  let text = txt(q.questiontext);
  for (const [i, id] of txt(ma.sequence).split(',').filter(Boolean).entries()) {
    const sub = byId.get(id.trim());
    const part = sub ? clozePart(sub) : null;
    if (!part) return null;
    text = text.replace(`{#${i + 1}}`, toClozeSource(part));
  }
  return text;
}

function clozePart(sub: Node): ClozePart | null {
  const mapped = mapMoodleQuestion(sub);
  const weight = Math.max(0, Math.round(num(sub.defaultmark, 1)));
  if (!mapped) return null;
  switch (mapped.type) {
    case 'SHORTANSWER': {
      const d = mapped.data as {
        caseSensitive: boolean;
        answers: { text: string; fraction: number; feedback: string }[];
      };
      return {
        kind: 'shortanswer',
        weight,
        caseSensitive: d.caseSensitive,
        answers: d.answers.map((a) => ({ ...a, feedback: plainText(a.feedback) })),
      };
    }
    case 'NUMERICAL': {
      const d = mapped.data as {
        answers: { value: number; tolerance: number; fraction: number; feedback: string }[];
      };
      return {
        kind: 'numerical',
        weight,
        answers: d.answers.map((a) => ({ ...a, feedback: plainText(a.feedback) })),
      };
    }
    case 'MULTICHOICE': {
      const d = mapped.data as {
        single: boolean;
        shuffleAnswers: boolean;
        answers: { id: string; text: string; fraction: number; feedback: string }[];
      };
      // Moodle's layouts: 0 a list, 1 vertical, 2 horizontal
      const layout = txt(
        (
          (sub.plugin_qtype_multichoice_question as Node | undefined)?.multichoice as
            | Node
            | undefined
        )?.layout,
      );
      const answers = d.answers.map((a) => ({
        ...a,
        text: plainText(a.text),
        feedback: plainText(a.feedback),
      }));
      return d.single
        ? {
            kind: 'multichoice',
            weight,
            display: layout === '1' ? 'vertical' : layout === '2' ? 'horizontal' : 'dropdown',
            shuffle: d.shuffleAnswers,
            answers,
          }
        : {
            kind: 'multiresponse',
            weight,
            display: layout === '2' ? 'horizontal' : 'vertical',
            shuffle: d.shuffleAnswers,
            answers,
          };
    }
    default:
      return null;
  }
}

const plainText = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** Feedback for right, partly right and wrong responses. */
const combinedFeedback = (o: Node) => ({
  feedbackCorrect: sanitizeRichText(txt(o.correctfeedback)),
  feedbackPartial: sanitizeRichText(txt(o.partiallycorrectfeedback)),
  feedbackIncorrect: sanitizeRichText(txt(o.incorrectfeedback)),
});

// ── import ───────────────────────────────────────────────────────────────────

export async function importMbz(
  ctx: RequestContext,
  archive: Archive,
  target: { categoryId: string; fullName?: string; shortName?: string },
): Promise<MbzReport> {
  const warnings: string[] = [];
  const t = createTranslator(ctx.locale);
  const info = ((xml(archive, 'moodle_backup.xml')?.moodle_backup as Node | undefined)
    ?.information ?? {}) as Node;
  const contents = (info.contents ?? {}) as Node;
  const courseXml = (xml(archive, 'course/course.xml')?.course ?? {}) as Node;
  const sectionsInfo = arr(((contents.sections ?? {}) as Node).section as Node | Node[]);
  const activitiesInfo = arr(((contents.activities ?? {}) as Node).activity as Node | Node[]);
  const files = arr((xml(archive, 'files.xml')?.files as Node | undefined)?.file as Node | Node[])
    .map(
      (f) =>
        ({
          contenthash: txt(f.contenthash),
          contextid: txt(f.contextid),
          component: txt(f.component),
          filearea: txt(f.filearea),
          itemid: txt(f.itemid),
          filepath: txt(f.filepath) || '/',
          filename: txt(f.filename),
          mimetype: txt(f.mimetype),
        }) as MbzFile,
    )
    .filter((f) => f.filename && f.filename !== '.');
  const blob = (f: MbzFile) => archive.get(`files/${f.contenthash.slice(0, 2)}/${f.contenthash}`);

  // sections in course order
  const sections = sectionsInfo
    .map((s) => {
      const x = root(xml(archive, `${txt(s.directory)}/section.xml`), 'section');
      return {
        moodleId: txt(s.sectionid),
        number: num(x.number),
        title: txt(x.name) || txt(s.title),
        summary: txt(x.summary),
        visible: txt(x.visible) !== '0',
        sequence: txt(x.sequence).split(',').filter(Boolean),
      };
    })
    .sort((a, b) => a.number - b.number);

  const fullName =
    target.fullName ??
    (txt(courseXml.fullname) || txt(info.original_course_fullname) || 'Imported course');
  let shortName =
    target.shortName ??
    (txt(courseXml.shortname) || txt(info.original_course_shortname) || 'IMPORT');
  if (!target.shortName) {
    const base = shortName;
    for (let i = 1; await ctx.db.course.findUnique({ where: { shortName } }); i++)
      shortName = `${base}-${i}`;
  }
  const { id: courseId } = await createCourse.run(ctx, {
    categoryId: target.categoryId,
    fullName,
    shortName,
    format: txt(courseXml.format) === 'weeks' ? 'WEEKS' : 'TOPICS',
    sections: Math.min(52, Math.max(0, sections.length - 1)),
    startDate: date(courseXml.startdate) ?? undefined,
    endDate: date(courseXml.enddate) ?? undefined,
  });
  try {
    return await fillCourse(courseId);
  } catch (e) {
    // a failed import leaves no half-built course behind
    await discardCourse(ctx, courseId);
    throw e;
  }

  async function fillCourse(courseId: string) {
    await addMissingSections(ctx, courseId, sections.length - 1);
    const db = ctx.db;
    let fileCount = 0;

    /** Stores files of a Moodle file area into the course editor area; returns name → URL. */
    const storeArea = async (
      contextid: string,
      component: string,
      filearea: string,
      itemid?: string,
    ) => {
      const urls = new Map<string, string>();
      for (const f of files.filter(
        (x) =>
          x.contextid === contextid &&
          x.component === component &&
          x.filearea === filearea &&
          (itemid === undefined || x.itemid === itemid),
      )) {
        const data = blob(f);
        if (!data) continue;
        const stored = await storeFile(db, {
          contextId: courseId,
          component: 'course',
          area: 'editor',
          name: f.filename,
          mimeType: f.mimetype,
          data,
          uploadedById: ctx.perm.userId ?? null,
        });
        fileCount++;
        urls.set(`${f.filepath.replace(/^\//, '')}${f.filename}`, fileUrl(stored));
      }
      return urls;
    };
    const rewrite = (htmlText: string, urls: Map<string, string>) =>
      sanitizeRichText(
        htmlText.replace(/@@PLUGINFILE@@\/([^"'\s)<>?#]+)/g, (_, p: string) => {
          const name = decodeURIComponent(p);
          return urls.get(name) ?? urls.get(name.split('/').pop() ?? '') ?? '#';
        }),
      );

    const courseCtx =
      txt(xml(archive, 'course/inforef.xml')?.contextid) || txt(courseXml['@_contextid']);
    const summaryFiles = await storeArea(courseCtx, 'course', 'summary');
    await db.course.update({
      where: { id: courseId },
      data: {
        summary: rewrite(txt(courseXml.summary), summaryFiles),
        customFields: mbzCourseFields(courseXml, await listCourseFields(db)),
      },
    });

    const newSections = await db.courseSection.findMany({
      where: { courseId },
      orderBy: { rank: 'asc' },
    });
    const sectionMap = new Map<string, string>();
    for (const [i, s] of sections.entries()) {
      const target = newSections[i] ?? newSections.at(-1)!;
      sectionMap.set(s.moodleId, target.id);
      await db.courseSection.update({
        where: { id: target.id },
        data: { title: s.title, summary: sanitizeRichText(s.summary), visible: s.visible },
      });
    }

    // question bank
    const qBank = xml(archive, 'questions.xml')?.question_categories as Node | undefined;
    const entryToQuestion = new Map<string, string>();
    const categoryMap = new Map<string, string>();
    let questionCount = 0;
    if (qBank) {
      const cats = arr(qBank.question_category as Node | Node[]);
      const pending = [...cats];
      while (pending.length) {
        const i = pending.findIndex(
          (c) =>
            !num(c.parent) ||
            categoryMap.has(txt(c.parent)) ||
            !cats.some((x) => x['@_id'] === txt(c.parent)),
        );
        const c = pending.splice(i === -1 ? 0 : i, 1)[0]!;
        const name = txt(c.name);
        if (name === 'top') {
          categoryMap.set(String(c['@_id']), '');
          continue;
        }
        const parent = categoryMap.get(txt(c.parent)) || null;
        const created = await db.questionCategory.create({
          data: {
            contextId: courseId,
            parentId: parent,
            name: name || t('qbank.importedCategory'),
            info: sanitizeRichText(txt(c.info)),
          },
        });
        categoryMap.set(String(c['@_id']), created.id);
        const fallbackCategory = created.id;
        // Moodle 4.x: entries → versions → question; 3.x: questions directly
        const entries = arr(
          (c.question_bank_entries as Node | undefined)?.question_bank_entry as Node | Node[],
        );
        const direct = arr((c.questions as Node | undefined)?.question as Node | Node[]);
        const groups: { entryId: string | null; questions: Node[] }[] = [
          ...entries.map((e) => {
            const versions = arr(
              arr(e.question_version as Node | Node[])[0]?.question_versions as Node | Node[],
            );
            const latest = versions.sort((a, b) => num(b.version) - num(a.version))[0];
            return {
              entryId: String(e['@_id']),
              questions: arr((latest?.questions as Node | undefined)?.question as Node | Node[]),
            };
          }),
          ...(direct.length ? [{ entryId: null, questions: direct }] : []),
        ];
        // a Cloze question's gaps come as questions of their own, pointing to it
        const byId = new Map(groups.flatMap((g) => g.questions).map((q) => [String(q['@_id']), q]));
        for (const g of groups) {
          for (const q of g.questions) {
            const parent = txt(q.parent);
            if (parent && parent !== '0' && parent !== String(q['@_id'])) continue;
            const cloze = txt(q.qtype) === 'multianswer' ? clozeText(q, byId) : null;
            const mapped: ReturnType<typeof mapMoodleQuestion> = cloze
              ? {
                  type: 'MULTIANSWER',
                  data: questionDataFrom('MULTIANSWER', sanitizeRichText(cloze), null),
                }
              : mapMoodleQuestion(q);
            const name = txt(q.name) || t('qbank.untitledQuestion');
            if (!mapped) {
              warnings.push(`Question "${name}": type ${txt(q.qtype)} is not supported`);
              continue;
            }
            const parsed = questionDataSchemas[mapped.type].safeParse(mapped.data);
            if (!parsed.success) {
              warnings.push(`Question "${name}": ${parsed.error.issues[0]?.message ?? 'invalid'}`);
              continue;
            }
            const text = sanitizeRichText(cloze ?? txt(q.questiontext));
            const sharedHere = (mapped.shared ?? []).map((s) => s.set);
            const textError =
              checkQuestionText(mapped.type, text, parsed.data) ??
              (mapped.type.startsWith('CALCULATED')
                ? checkVariants(mapped.type as 'CALCULATED', text, parsed.data as never, sharedHere)
                : null);
            if (textError) {
              warnings.push(`Question "${name}": ${textError}`);
              continue;
            }
            // datasets shared in Moodle categories go to the matching categories here,
            // unless one of that name is there already
            for (const s of mapped.shared ?? []) {
              const categoryId = categoryMap.get(s.category) || fallbackCategory;
              await db.questionDataset.upsert({
                where: { categoryId_name: { categoryId, name: s.set.name } },
                create: {
                  categoryId,
                  name: s.set.name,
                  min: s.set.min,
                  max: s.set.max,
                  decimals: s.set.decimals,
                  distribution: s.set.distribution === 'loguniform' ? 'LOGUNIFORM' : 'UNIFORM',
                  items: s.set.items,
                },
                update: {},
              });
            }
            if (mapped.unitsLeftOut) warnings.push(`Question "${name}": ${UNITS_LEFT_OUT}`);
            const created2 = await db.question.create({
              data: {
                categoryId: fallbackCategory,
                type: mapped.type,
                name: name.slice(0, 255),
                text,
                generalFeedback: sanitizeRichText(txt(q.generalfeedback)),
                defaultMark: mapped.type === 'DESCRIPTION' ? 0 : num(q.defaultmark, 1),
                penalty: Math.min(1, Math.max(0, num(q.penalty))),
                hints: mbzHints(q) as unknown as Prisma.InputJsonValue,
                data: parsed.data as Prisma.InputJsonValue,
                source: 'IMPORT',
                createdById: ctx.perm.userId ?? null,
              },
            });
            questionCount++;
            if (g.entryId) entryToQuestion.set(g.entryId, created2.id);
            entryToQuestion.set(`q:${String(q['@_id'])}`, created2.id);
          }
        }
      }
    }

    // scales (the site's come as the course's), then groups and groupings without members
    const scaleMap = new Map<string, string>();
    for (const sc of arr(
      (xml(archive, 'scales.xml')?.scales_definition as Node | undefined)?.scale as Node | Node[],
    )) {
      const items = txt(sc.scale)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      if (!items.length) continue;
      const created = await db.scale.create({
        data: { courseId, name: (txt(sc.name) || items.join(', ')).slice(0, 255), items },
      });
      scaleMap.set(String(sc['@_id']), created.id);
    }
    const scaleOf = (moodleId: string) => scaleMap.get(moodleId);
    const groupMap = new Map<string, string>();
    const groupingMap = new Map<string, string>();
    const groupsXml = (xml(archive, 'groups.xml')?.groups ?? {}) as Node;
    for (const g of arr(groupsXml.group as Node | Node[])) {
      const name = txt(g.name).slice(0, 255);
      if (!name) continue;
      const created = await db.group.create({
        data: {
          courseId,
          name,
          idNumber: txt(g.idnumber) || null,
          description: sanitizeRichText(txt(g.description)),
        },
      });
      groupMap.set(String(g['@_id']), created.id);
    }
    for (const gg of arr(((groupsXml.groupings ?? {}) as Node).grouping as Node | Node[])) {
      const name = txt(gg.name).slice(0, 255);
      if (!name) continue;
      const created = await db.grouping.create({
        data: { courseId, name, description: sanitizeRichText(txt(gg.description)) },
      });
      groupingMap.set(String(gg['@_id']), created.id);
      const members = arr(((gg.grouping_groups ?? {}) as Node).grouping_group as Node | Node[])
        .map((x) => groupMap.get(txt(x.groupid)))
        .filter((x): x is string => !!x);
      if (members.length)
        await db.groupingGroup.createMany({
          data: members.map((groupId) => ({ groupingId: created.id, groupId })),
          skipDuplicates: true,
        });
    }
    const groupCount = groupMap.size;
    if (groupCount) warnings.push(`${groupCount} groups were created without their members`);

    // activities in section order
    const actInfo = new Map(activitiesInfo.map((a) => [txt(a.moduleid), a]));
    const ordered = sections.flatMap((s) =>
      s.sequence.filter((id) => actInfo.has(id)).map((id) => ({ section: s, a: actInfo.get(id)! })),
    );
    for (const a of activitiesInfo) {
      if (!ordered.some((o) => o.a === a)) {
        const s = sections.find((x) => x.moodleId === txt(a.sectionid)) ?? sections[0]!;
        ordered.push({ section: s, a });
      }
    }
    let activityCount = 0;
    const createdActivities: { dir: string; id: string }[] = [];
    const idNumberTaken = async (idNumber: string) => {
      const where = { courseId, idNumber: { equals: idNumber, mode: 'insensitive' as const } };
      return !!(
        (await db.gradeItem.findFirst({ where })) ?? (await db.gradeCategory.findFirst({ where }))
      );
    };
    for (const { section, a } of ordered) {
      const dir = txt(a.directory);
      const modname = txt(a.modulename);
      const module = (xml(archive, `${dir}/module.xml`)?.module ?? {}) as Node;
      const actRoot = root(xml(archive, `${dir}/${modname}.xml`), 'activity');
      const data = (actRoot[modname] ?? {}) as Node;
      const contextid = String(actRoot['@_contextid'] ?? '');
      const name = (txt(data.name) || txt(a.title) || modname).slice(0, 255);
      const sectionId = sectionMap.get(section.moodleId) ?? newSections[0]!.id;
      const introFiles = await storeArea(contextid, `mod_${modname}`, 'intro');
      const intro = rewrite(txt(data.intro), introFiles);
      const groupMode = ({ '1': 'SEPARATE', '2': 'VISIBLE' } as const)[txt(module.groupmode)];
      // an ID number already in the gradebook stays with the first (and is reported)
      let idNumber: string | null = txt(module.idnumber).trim().slice(0, 100) || null;
      if (idNumber && (await idNumberTaken(idNumber))) {
        warnings.push(`"${name}": the ID number ${idNumber} is used already and was left out`);
        idNumber = null;
      }
      const base = {
        courseId,
        sectionId,
        name,
        intro,
        showIntro: txt(module.showdescription) === '1',
        visibility: txt(module.visible) === '0' ? ('HIDDEN' as const) : ('SHOWN' as const),
        groupMode: groupMode ?? ('NONE' as const),
        groupingId: groupingMap.get(txt(module.groupingid)) ?? null,
        idNumber: idNumber ?? undefined,
      };
      // what the gradebook and the activity's own data are matched by afterwards
      const create = async (input: Parameters<typeof importActivity.run>[1]) => {
        const r = await importActivity.run(ctx, input);
        createdActivities.push({ dir, id: r.id });
        return r;
      };
      const placeholder = async (why: string) => {
        warnings.push(`"${name}" (${modname}): ${why}`);
        await create({
          ...base,
          idNumber: undefined,
          moduleKey: 'label',
          settings: { content: `<p><strong>${name.replace(/[<>&]/g, '')}</strong></p>${intro}` },
        });
        activityCount++;
      };
      try {
        switch (modname) {
          case 'page': {
            const content = rewrite(
              txt(data.content),
              await storeArea(contextid, 'mod_page', 'content'),
            );
            await create({ ...base, moduleKey: 'page', settings: { content } });
            break;
          }
          case 'label':
            await create({
              ...base,
              intro: '',
              moduleKey: 'label',
              settings: { content: intro },
            });
            break;
          case 'url': {
            const url = txt(data.externalurl);
            if (!/^https?:\/\//i.test(url)) {
              await placeholder('link is not http(s)');
              continue;
            }
            await create({
              ...base,
              moduleKey: 'url',
              settings: { url, display: 'newtab' },
            });
            break;
          }
          case 'resource':
          case 'folder': {
            const { id } = await create({
              ...base,
              moduleKey: 'file',
              settings: { display: 'list' },
            });
            for (const f of files.filter(
              (x) =>
                x.contextid === contextid &&
                x.component === `mod_${modname}` &&
                x.filearea === 'content',
            )) {
              const b = blob(f);
              if (!b) continue;
              await storeFile(db, {
                contextId: id,
                component: 'mod.file',
                area: 'content',
                path: f.filepath,
                name: f.filename,
                mimeType: f.mimetype,
                data: b,
                uploadedById: ctx.perm.userId ?? null,
              });
              fileCount++;
            }
            break;
          }
          case 'assign': {
            const form = mbzGradingForm(xml(archive, `${dir}/grading.xml`));
            const settings = {
              ...mbzAssignSettings(data, scaleOf),
              gradingMethod: form?.method ?? 'simple',
            };
            if (num(data.grade, 100) < 0 && !settings.scaleId)
              warnings.push(`"${name}": its scale was not in the backup: graded by points`);
            // teams are the groups of the assignment's team grouping
            const teams = groupingMap.get(txt(data.teamsubmissiongroupingid));
            const { id } = await create({
              ...base,
              groupingId: base.groupingId ?? (settings.teamSubmission ? (teams ?? null) : null),
              moduleKey: 'assign',
              settings,
            });
            if (form) {
              const parsed = (form.method === 'rubric' ? Rubric : Guide).safeParse(form.definition);
              if (parsed.success)
                await db.gradingDefinition.create({
                  data: {
                    activityId: id,
                    area: 'submission',
                    method: form.method === 'rubric' ? 'RUBRIC' : 'GUIDE',
                    definition: parsed.data as Prisma.InputJsonValue,
                  },
                });
              else
                warnings.push(`"${name}": its ${form.method} could not be read and was left out`);
            }
            if (settings.blindMarking && txt(data.revealidentities) === '1')
              await db.assignState.create({
                data: { activityId: id, identitiesRevealedAt: new Date() },
              });
            // the dates of groups (students' own are user data, left out)
            for (const o of arr(((data.overrides ?? {}) as Node).override as Node | Node[])) {
              const groupId = groupMap.get(txt(o.groupid));
              if (!groupId) continue;
              await db.assignOverride.create({
                data: {
                  activityId: id,
                  groupId,
                  sortOrder: num(o.sortorder),
                  allowSubmissionsFrom: date(o.allowsubmissionsfromdate),
                  dueAt: date(o.duedate),
                  cutoffAt: date(o.cutoffdate),
                },
              });
            }
            break;
          }
          case 'quiz': {
            const grade = num(data.grade, 10);
            const methods: Record<string, string> = {
              '1': 'HIGHEST',
              '2': 'AVERAGE',
              '3': 'FIRST',
              '4': 'LAST',
            };
            // address entries Hubium cannot read are left out (and reported)
            const badNets = invalidIpListEntries(txt(data.subnet));
            if (badNets.length)
              warnings.push(`"${name}": network addresses skipped: ${badNets.join(', ')}`);
            const subnet = txt(data.subnet)
              .split(/[\s,;]+/)
              .filter((e) => e && !badNets.includes(e))
              .join(', ');
            const { id } = await create({
              ...base,
              moduleKey: 'quiz',
              settings: {
                openAt: date(data.timeopen),
                closeAt: date(data.timeclose),
                timeLimitMin: Math.round(num(data.timelimit) / 60),
                attempts: num(data.attempts),
                gradeMethod: methods[txt(data.grademethod)] ?? 'HIGHEST',
                gradeMax: grade > 0 ? grade : 10,
                perPage: num(data.questionsperpage, 1),
                shuffleAnswers: txt(data.shuffleanswers) !== '0',
                password: txt(data.password),
                subnet,
                delay1Min: Math.ceil(num(data.delay1) / 60),
                delay2Min: Math.ceil(num(data.delay2) / 60),
                navMethod: txt(data.navmethod) === 'seq' ? 'sequential' : 'free',
                ...quizBehaviour(data, (why) => warnings.push(`"${name}": ${why}`)),
              },
            });
            const instances = arr(
              (data.question_instances as Node | undefined)?.question_instance as Node | Node[],
            );
            let slot = 0;
            for (const qi of instances.sort((x, y) => num(x.slot) - num(y.slot))) {
              const ref = (qi.question_reference ?? {}) as Node;
              const qid =
                entryToQuestion.get(txt(ref.questionbankentryid)) ??
                entryToQuestion.get(`q:${txt(qi.questionid ?? qi.question)}`);
              const set = (qi.question_set_reference ?? {}) as Node;
              let categoryId: string | undefined;
              const filter = txt(set.filtercondition);
              if (!qid && filter) {
                try {
                  const fc = JSON.parse(filter) as {
                    questioncategoryid?: number | string;
                    filter?: { category?: { values?: (string | number)[] } };
                  };
                  const cid = String(
                    fc.questioncategoryid ?? fc.filter?.category?.values?.[0] ?? '',
                  );
                  categoryId = categoryMap.get(cid) || undefined;
                } catch {}
              }
              if (!qid && !categoryId) {
                warnings.push(
                  `"${name}": slot ${txt(qi.slot)} refers to a question that was not imported`,
                );
                continue;
              }
              await db.quizSlot.create({
                data: {
                  activityId: id,
                  slot: ++slot,
                  page: Math.max(1, num(qi.page, 1)),
                  kind: qid ? 'FIXED' : 'RANDOM',
                  questionId: qid ?? null,
                  categoryId: qid ? null : categoryId,
                  maxMark: num(qi.maxmark, 1),
                },
              });
            }
            break;
          }
          case 'forum': {
            const type = txt(data.type);
            if (type === 'news') {
              warnings.push(
                `"${name}": the announcements forum maps to the course stream and was skipped`,
              );
              continue;
            }
            const grading = mbzForumGrading(data, scaleOf);
            if (
              (num(data.scale) < 0 && !grading.ratingScaleId) ||
              (num(data.grade_forum) < 0 && !grading.gradeScaleId)
            )
              warnings.push(`"${name}": its scale was not in the backup: graded by points`);
            await create({
              ...base,
              moduleKey: 'forum',
              settings: { type: type === 'qanda' ? 'qanda' : 'general', ...grading },
            });
            break;
          }
          case 'scorm': {
            const pkg = files.find(
              (x) =>
                x.contextid === contextid &&
                x.component === 'mod_scorm' &&
                x.filearea === 'package',
            );
            const b = pkg && blob(pkg);
            if (!b || !getModule('scorm')) {
              await placeholder('SCORM package file is missing');
              continue;
            }
            const { id } = await create({
              ...base,
              moduleKey: 'scorm',
              settings: { gradeMax: num(data.maxgrade, 100) || 100 },
            });
            await storeFile(db, {
              contextId: id,
              component: 'mod.scorm',
              area: 'package',
              name: pkg.filename,
              mimeType: 'application/zip',
              data: b,
              uploadedById: ctx.perm.userId ?? null,
            });
            fileCount++;
            const act = await db.activity.findUniqueOrThrow({ where: { id } });
            await getModule('scorm')!.backup?.import?.(
              buildModuleCtx(ctx),
              toActivityRef(act) as never,
              null,
              () => undefined,
            );
            break;
          }
          case 'h5pactivity': {
            // the package and the settings; attempts are users' data
            const pkg = files.find(
              (x) =>
                x.contextid === contextid &&
                x.component === 'mod_h5pactivity' &&
                x.filearea === 'package',
            );
            const b = pkg && blob(pkg);
            if (!b || !getModule('h5p')) {
              await placeholder('H5P package file is missing');
              continue;
            }
            const h = mbzH5pSettings(data);
            const left: string[] = [];
            if (h.attempts) left.push(`attempts, which are users' data (${h.attempts})`);
            if (h.manual) left.push('manual grading (the best attempt is graded)');
            if (h.onScale) left.push('the scale (graded by points)');
            if (left.length) warnings.push(`"${name}": left out ${left.join('; ')}`);
            const { id } = await create({ ...base, moduleKey: 'h5p', settings: h.settings });
            await storeFile(db, {
              contextId: id,
              component: 'mod.h5p',
              area: 'package',
              name: pkg.filename,
              mimeType: 'application/zip',
              data: b,
              uploadedById: ctx.perm.userId ?? null,
            });
            fileCount++;
            const act = await db.activity.findUniqueOrThrow({ where: { id } });
            await getModule('h5p')!.backup?.import?.(
              buildModuleCtx(ctx),
              toActivityRef(act) as never,
              null,
              () => undefined,
            );
            break;
          }
          case 'bigbluebuttonbn': {
            if (!getModule('livesession')) {
              await placeholder('live sessions are not installed');
              continue;
            }
            const start = date(data.openingtime) ?? new Date(Date.now() + 86_400_000).toISOString();
            const close = num(data.closingtime);
            await create({
              ...base,
              moduleKey: 'livesession',
              settings: {
                provider: 'bbb',
                startsAt: start,
                durationMin:
                  close > num(data.openingtime) && num(data.openingtime) > 0
                    ? Math.min(720, Math.round((close - num(data.openingtime)) / 60))
                    : 60,
                record: txt(data.record) === '1',
                welcome: txt(data.welcome).slice(0, 2000),
              },
            });
            break;
          }
          case 'lti':
            await placeholder('external tools must be registered and mapped by an administrator');
            continue;
          case 'book': {
            const numbering =
              (['none', 'numbers', 'bullets', 'indented'] as const)[num(data.numbering, 1)] ??
              'numbers';
            const { id } = await create({
              ...base,
              moduleKey: 'book',
              settings: { numbering, customTitles: txt(data.customtitles) === '1' },
            });
            const chapters = arr(((data.chapters ?? {}) as Node).chapter as Node | Node[]).sort(
              (x, y) => num(x.pagenum) - num(y.pagenum),
            );
            for (const [i, c] of chapters.entries()) {
              const urls = await storeArea(contextid, 'mod_book', 'chapter', String(c['@_id']));
              await db.bookChapter.create({
                data: {
                  activityId: id,
                  sortOrder: i,
                  subchapter: i > 0 && txt(c.subchapter) === '1',
                  title: (txt(c.title) || '—').slice(0, 255),
                  content: rewrite(txt(c.content), urls),
                  hidden: txt(c.hidden) === '1',
                },
              });
            }
            break;
          }
          case 'choice': {
            const options = arr(((data.options ?? {}) as Node).option as Node | Node[])
              .map((o) => ({ text: txt(o.text).trim().slice(0, 255), limit: num(o.maxanswers) }))
              .filter((o) => o.text);
            if (!options.length) {
              await placeholder('the choice has no options');
              continue;
            }
            const date = (v: unknown) =>
              num(v) > 0 ? new Date(num(v) * 1000).toISOString() : null;
            await create({
              ...base,
              moduleKey: 'choice',
              settings: {
                options,
                allowMultiple: txt(data.allowmultiple) === '1',
                allowUpdate: txt(data.allowupdate) === '1',
                limitAnswers: txt(data.limitanswers) === '1',
                showResults:
                  (['never', 'afterAnswer', 'afterClose', 'always'] as const)[
                    num(data.showresults)
                  ] ?? 'never',
                publish: txt(data.publish) === '1' ? 'names' : 'anonymous',
                showUnanswered: txt(data.showunanswered) === '1',
                opensAt: date(data.timeopen),
                closesAt: date(data.timeclose),
                showPreview: txt(data.showpreview) === '1',
              },
            });
            break;
          }
          case 'feedback': {
            const date = (v: unknown) =>
              num(v) > 0 ? new Date(num(v) * 1000).toISOString() : null;
            const plain = (html: string) =>
              html
                .replace(/<br\s*\/?>|<\/p>/gi, '\n')
                .replace(/<[^>]*>/g, '')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            const { id } = await create({
              ...base,
              moduleKey: 'feedback',
              settings: {
                // 1 is anonymous in Moodle, 2 with names
                anonymous: txt(data.anonymous) !== '2',
                multipleSubmit: txt(data.multiple_submit) === '1',
                showAnalysis: txt(data.publish_stats) === '1',
                notifyTeachers: txt(data.email_notification) === '1',
                autoNumbering: txt(data.autonumbering) !== '0',
                opensAt: date(data.timeopen),
                closesAt: date(data.timeclose),
                thankYou: plain(txt(data.page_after_submit)).slice(0, 2000),
              },
            });
            const items = arr(((data.items ?? {}) as Node).item as Node | Node[]).sort(
              (x, y) => num(x.position) - num(y.position),
            );
            let n = 0;
            const skipped = new Set<string>();
            for (const it of items) {
              const typ = txt(it.typ);
              const label = plain(txt(it.name)).slice(0, 5000);
              const presentation = txt(it.presentation);
              let row: { type: string; label: string; options: object } | null = null;
              if (typ === 'label') row = { type: 'info', label: plain(presentation), options: {} };
              else if (typ === 'pagebreak') row = { type: 'pagebreak', label: '', options: {} };
              else if (typ === 'textfield') row = { type: 'text', label, options: {} };
              else if (typ === 'textarea') row = { type: 'textarea', label, options: {} };
              else if (typ === 'numeric') {
                const [min, max] = presentation
                  .split('|')
                  .map((v) => (v.trim() === '' ? null : Number(v)));
                row = {
                  type: 'number',
                  label,
                  options: {
                    min: Number.isFinite(min) ? min : null,
                    max: Number.isFinite(max) ? max : null,
                  },
                };
              } else if (typ === 'multichoice' || typ === 'multichoicerated') {
                // "r>>>>>one|two" (r radio, c checkboxes, d drop-down); rated options are "1####one"
                const [kind, list = ''] = presentation.split('>>>>>');
                const choices = list
                  .split('<<<<<')[0]!
                  .split('|')
                  .map((c) => plain(c.includes('####') ? c.split('####')[1]! : c))
                  .filter(Boolean)
                  .slice(0, 100);
                if (choices.length >= 2)
                  row = {
                    type: 'choice',
                    label,
                    options: {
                      choices,
                      multiple: kind === 'c',
                      display: kind === 'd' ? 'dropdown' : 'radio',
                    },
                  };
              }
              if (!row || (row.type !== 'pagebreak' && !row.label)) {
                skipped.add(typ);
                continue;
              }
              await db.feedbackItem.create({
                data: {
                  activityId: id,
                  sortOrder: n++,
                  ...row,
                  required:
                    row.type !== 'info' && row.type !== 'pagebreak' && txt(it.required) === '1',
                },
              });
            }
            if (skipped.size)
              warnings.push(
                `"${name}": questions of type ${[...skipped].join(', ')} were left out`,
              );
            break;
          }
          case 'lesson': {
            // the pages and their jumps; attempts are users' data
            const settings = mbzLessonSettings(data);
            const { pages, skipped } = await mbzLessonPages(data, async (pageId, html) =>
              rewrite(html, await storeArea(contextid, 'mod_lesson', 'page_contents', pageId)),
            );
            const left: string[] = [];
            if (num(data.grade) < 0) left.push('its scale (graded by points)');
            if (txt(data.usepassword) === '1')
              left.push('the password (Moodle keeps only its hash)');
            if (num(data.nextpagedefault) !== 0) left.push('the action after a correct answer');
            if (txt(data.slideshow) === '1') left.push('the slide show');
            if (num(data.dependency) > 0) left.push('the dependency on another lesson');
            if (skipped.length) left.push(`pages of type ${skipped.join(', ')}`);
            if (left.length) warnings.push(`"${name}": left out ${left.join('; ')}`);
            const { id } = await create({ ...base, moduleKey: 'lesson', settings });
            const act = await db.activity.findUniqueOrThrow({ where: { id } });
            await getModule('lesson')?.backup?.import?.(
              buildModuleCtx(ctx),
              toActivityRef(act) as never,
              { pages },
              () => undefined,
            );
            break;
          }
          case 'wiki': {
            // the settings; pages are users' work (Moodle keeps them in subwikis)
            const pages = arr(((data.subwikis ?? {}) as Node).subwiki as Node | Node[]).reduce(
              (n, sw) => n + arr(((sw.pages ?? {}) as Node).page as Node | Node[]).length,
              0,
            );
            if (pages)
              warnings.push(`"${name}": pages are users' data and were left out (${pages})`);
            await create({
              ...base,
              moduleKey: 'wiki',
              settings: {
                mode: txt(data.wikimode) === 'individual' ? 'individual' : 'collaborative',
                firstPageTitle: plainText(txt(data.firstpagetitle)).slice(0, 255),
              },
            });
            break;
          }
          case 'data': {
            // fields, templates and settings; entries are users' data
            const DATA_TYPES: Record<string, string> = {
              text: 'text',
              textarea: 'textarea',
              number: 'number',
              date: 'date',
              menu: 'menu',
              radiobutton: 'radio',
              checkbox: 'checkbox',
              multimenu: 'checkbox',
              url: 'url',
              file: 'file',
              picture: 'image',
            };
            const all = arr(((data.fields ?? {}) as Node).field as Node | Node[]);
            const skippedTypes = new Set<string>();
            const fields = all.flatMap((f) => {
              const type = DATA_TYPES[txt(f.type)];
              if (!type) {
                skippedTypes.add(txt(f.type));
                return [];
              }
              const choices = txt(f.param1)
                .split(/\r?\n/)
                .map((c) => c.trim())
                .filter(Boolean);
              return [
                {
                  type,
                  name: plainText(txt(f.name)).slice(0, 255),
                  description: plainText(txt(f.description)).slice(0, 2000),
                  required: txt(f.required) === '1',
                  options:
                    type === 'menu' || type === 'radio' || type === 'checkbox'
                      ? { choices }
                      : type === 'url' && txt(f.param2) && txt(f.param2) !== '0'
                        ? { linkText: plainText(txt(f.param2)) }
                        : {},
                },
              ];
            });
            const sortField = all.find((f) => String(f['@_id']) === txt(data.defaultsort));
            const grading = mbzForumGrading(data, scaleOf);
            const entries = arr(((data.records ?? {}) as Node).record as Node | Node[]).length;
            const left: string[] = [];
            if (entries) left.push(`entries, which are users' data (${entries})`);
            if (skippedTypes.size) left.push(`fields of type ${[...skippedTypes].join(', ')}`);
            if (num(data.scale) < 0 && !grading.ratingScaleId)
              left.push('its scale (graded by points)');
            if (left.length) warnings.push(`"${name}": left out ${left.join('; ')}`);
            const { id } = await create({
              ...base,
              moduleKey: 'data',
              settings: {
                approvalRequired: txt(data.approval) === '1',
                maxEntries: Math.min(10_000, Math.max(0, num(data.maxentries))),
                requiredEntriesToView: Math.min(1000, Math.max(0, num(data.requiredentriestoview))),
                opensAt: date(data.timeavailablefrom),
                closesAt: date(data.timeavailableto),
                defaultSort: sortField ? plainText(txt(sortField.name)).slice(0, 255) : '',
                defaultOrder: txt(data.defaultsortdir) === '1' ? 'desc' : 'asc',
                listTemplate: txt(data.listtemplate),
                singleTemplate: txt(data.singletemplate),
                ratingAggregate: grading.ratingAggregate,
                ratingMax: grading.ratingMax,
                ratingScaleId: grading.ratingScaleId,
                ratingFrom: grading.ratingFrom,
                ratingTo: grading.ratingTo,
              },
            });
            const act = await db.activity.findUniqueOrThrow({ where: { id } });
            await getModule('data')?.backup?.import?.(
              buildModuleCtx(ctx),
              toActivityRef(act) as never,
              { fields },
              () => undefined,
            );
            break;
          }
          case 'workshop': {
            // the settings and the assessment form; work and assessments are users' data
            const w = mbzWorkshop(data);
            const left: string[] = [];
            if (w.submissions) left.push(`submissions, which are users' data (${w.submissions})`);
            if (w.examples) left.push('example submissions');
            if (w.unknownStrategy)
              left.push(`the grading strategy ${txt(data.strategy)} (accumulative is used)`);
            if (w.onScale) left.push('scales of criteria (graded by points)');
            if (left.length) warnings.push(`"${name}": left out ${left.join('; ')}`);
            const { id } = await create({ ...base, moduleKey: 'workshop', settings: w.settings });
            const act = await db.activity.findUniqueOrThrow({ where: { id } });
            await getModule('workshop')?.backup?.import?.(
              buildModuleCtx(ctx),
              toActivityRef(act) as never,
              { forms: w.form },
              () => undefined,
            );
            break;
          }
          case 'glossary': {
            // the settings; entries are users' work and stay out like forum posts
            const grading = mbzForumGrading(data, scaleOf);
            if (num(data.scale) < 0 && !grading.ratingScaleId)
              warnings.push(`"${name}": its scale was not in the backup: graded by points`);
            const entries = arr(((data.entries ?? {}) as Node).entry as Node | Node[]).length;
            if (entries)
              warnings.push(`"${name}": entries are users' data and were left out (${entries})`);
            await create({
              ...base,
              moduleKey: 'glossary',
              settings: {
                approvalRequired: txt(data.defaultapproval) === '0',
                allowDuplicates: txt(data.allowduplicatedentries) === '1',
                autoLink: txt(data.usedynalink) === '1',
                displayFormat: txt(data.displayformat) === 'dictionary' ? 'dictionary' : 'full',
                entriesPerPage: Math.min(200, Math.max(5, num(data.entbypage, 10) || 10)),
                ratingAggregate: grading.ratingAggregate,
                ratingMax: grading.ratingMax,
                ratingScaleId: grading.ratingScaleId,
                ratingFrom: grading.ratingFrom,
                ratingTo: grading.ratingTo,
              },
            });
            break;
          }
          default:
            await placeholder('this activity type is not supported');
            continue;
        }
        activityCount++;
      } catch (e) {
        warnings.push(
          `"${name}" (${modname}) was skipped: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    await importGradebook();

    return {
      courseId,
      moodleRelease: txt(info.moodle_release),
      sections: sections.length,
      activities: activityCount,
      questions: questionCount,
      files: fileCount,
      warnings: [...warnings, ...disabledTypesWarning(await disabledTypesIn(db, courseId))],
    };

    /**
     * The gradebook: the category tree, manual items, ID numbers, letters and formulas,
     * whose ##giNN## references follow the items and categories (a category's item
     * stands for the category) to their copies. Grades are user data, left out.
     */
    async function importGradebook() {
      const gb = xml(archive, 'gradebook.xml')?.gradebook as Node | undefined;
      if (!gb) return;
      const warnGb = (why: string) => warnings.push(`Gradebook: ${why}`);
      const { root: gradeRoot } = await ensureCourseGradebook(db, courseId);
      const catMap = new Map<string, string>();
      const catAggregation = new Map<string, string>();
      const cats = arr(((gb.grade_categories ?? {}) as Node).grade_category as Node | Node[]).sort(
        (x, y) => num(x.depth) - num(y.depth),
      );
      for (const c of cats) {
        const id = String(c['@_id']);
        const aggregation = gradeAggregation(txt(c.aggregation), warnGb);
        const common = {
          aggregation,
          dropLowest: Math.min(100, num(c.droplow)),
          keepHighest: Math.min(100, num(c.keephigh)),
          aggregateOnlyGraded: txt(c.aggregateonlygraded) !== '0',
        };
        if (!txt(c.parent)) {
          catMap.set(id, gradeRoot.id);
          await db.gradeCategory.update({ where: { id: gradeRoot.id }, data: common });
        } else {
          const created = await db.gradeCategory.create({
            data: {
              ...common,
              courseId,
              parentId: catMap.get(txt(c.parent)) ?? gradeRoot.id,
              name: (txt(c.fullname) || '—').slice(0, 255),
              hidden: num(c.hidden) !== 0,
              sortOrder: num(c.sortorder),
            },
          });
          catMap.set(id, created.id);
        }
        catAggregation.set(catMap.get(id)!, aggregation);
      }
      /** Weight in the parent: its own with a weighted mean, otherwise 1. */
      const weightIn = (categoryId: string, it: Node) =>
        catAggregation.get(categoryId) === 'WEIGHTED_MEAN' ? num(it.aggregationcoef, 1) : 1;
      const token = new Map<string, string>();
      const formulas: { id: string; name: string; calculation: string }[] = [];
      const freeIdNumber = async (v: unknown, what: string) => {
        const idNumber = txt(v).trim().slice(0, 100);
        if (!idNumber) return null;
        if (await idNumberTaken(idNumber)) {
          warnGb(`${what}: the ID number ${idNumber} is used already and was left out`);
          return null;
        }
        return idNumber;
      };
      const displays: Record<string, 'REAL' | 'PERCENT' | 'LETTER'> = {
        '1': 'REAL',
        '2': 'PERCENT',
        '3': 'LETTER',
      };
      for (const it of arr(((gb.grade_items ?? {}) as Node).grade_item as Node | Node[])) {
        const id = String(it['@_id']);
        const type = txt(it.itemtype);
        const name = (txt(it.itemname) || '—').slice(0, 255);
        if (type === 'course' || type === 'category') {
          if (txt(it.calculation)) warnGb('calculated category totals are not supported');
          if (type === 'course') continue;
          const categoryId = catMap.get(txt(it.iteminstance));
          if (!categoryId) continue;
          token.set(id, `##gc${categoryId}##`);
          const cat = await db.gradeCategory.findUniqueOrThrow({ where: { id: categoryId } });
          await db.gradeCategory.update({
            where: { id: categoryId },
            data: {
              idNumber: await freeIdNumber(it.idnumber, cat.name),
              weight: cat.parentId ? weightIn(cat.parentId, it) : 1,
              hidden: cat.hidden || num(it.hidden) !== 0,
            },
          });
          continue;
        }
        if (type !== 'manual') continue;
        const gradeType = txt(it.gradetype);
        if (gradeType !== '1' && gradeType !== '2') {
          warnGb(`"${name}": only items graded by points or a scale are imported`);
          continue;
        }
        const scaleId = gradeType === '2' ? scaleMap.get(txt(it.scaleid)) : undefined;
        if (gradeType === '2' && !scaleId)
          warnGb(`"${name}": its scale was not in the backup: graded by points`);
        const scale = scaleId ? await db.scale.findUniqueOrThrow({ where: { id: scaleId } }) : null;
        const categoryId = catMap.get(txt(it.categoryid)) ?? gradeRoot.id;
        const created = await db.gradeItem.create({
          data: {
            courseId,
            categoryId,
            kind: 'MANUAL',
            name,
            idNumber: await freeIdNumber(it.idnumber, name),
            gradeType: scale ? 'SCALE' : 'VALUE',
            scaleId: scale?.id ?? null,
            gradeMin: scale ? 1 : num(it.grademin),
            gradeMax: scale ? scale.items.length : num(it.grademax, 100),
            gradePass: num(it.gradepass) || null,
            weight: weightIn(categoryId, it),
            display: scale ? 'REAL' : (displays[txt(it.display)] ?? 'REAL'),
            decimals: Math.min(5, Math.max(0, num(it.decimals, 2))),
            hidden: num(it.hidden) !== 0,
            locked: num(it.locked) !== 0,
            sortOrder: num(it.sortorder),
          },
        });
        token.set(id, `##gi${created.id}##`);
        if (txt(it.calculation))
          formulas.push({ id: created.id, name, calculation: txt(it.calculation) });
      }
      // activities' items: their category, weight and ID numbers, from each grades.xml
      for (const act of createdActivities) {
        const items = arr(
          (
            (xml(archive, `${act.dir}/grades.xml`)?.activity_gradebook as Node | undefined)
              ?.grade_items as Node | undefined
          )?.grade_item as Node | Node[],
        );
        for (const it of items) {
          const own = await db.gradeItem.findFirst({
            where: { activityId: act.id, itemNumber: num(it.itemnumber) },
          });
          if (!own) continue;
          token.set(String(it['@_id']), `##gi${own.id}##`);
          const categoryId = catMap.get(txt(it.categoryid)) ?? gradeRoot.id;
          const idNumber = own.idNumber ?? (await freeIdNumber(it.idnumber, own.name));
          await db.gradeItem.update({
            where: { id: own.id },
            data: { categoryId, weight: weightIn(categoryId, it), idNumber },
          });
        }
      }
      // formulas, their references following; one that cannot be read or ordered is left out
      for (const f of formulas) {
        const stored = f.calculation
          .replace(/##gi(\d+)##/g, (all, moodleId: string) => token.get(moodleId) ?? all)
          .trim();
        try {
          calculationRefs(stored);
          await db.gradeItem.update({
            where: { id: f.id },
            data: { calculation: stored.startsWith('=') ? stored : `=${stored}` },
          });
        } catch {
          warnGb(`"${f.name}": its formula could not be read and was left out`);
        }
      }
      const [categories, items] = await Promise.all([
        db.gradeCategory.findMany({ where: { courseId } }),
        db.gradeItem.findMany({ where: { courseId } }),
      ]);
      try {
        calculationOrder(items, categories);
      } catch {
        warnGb('formulas that use their own grade were left out');
        await db.gradeItem.updateMany({
          where: { courseId, calculation: { not: null } },
          data: { calculation: null },
        });
      }
      const letters = arr(((gb.grade_letters ?? {}) as Node).grade_letter as Node | Node[]);
      if (letters.length)
        await db.gradeLetter.createMany({
          data: letters.map((l) => ({
            contextId: courseId,
            lowerBound: num(l.lowerboundary),
            letter: txt(l.letter).slice(0, 20) || '?',
          })),
          skipDuplicates: true,
        });
    }
  }
}
