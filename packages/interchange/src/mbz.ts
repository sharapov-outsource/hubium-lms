import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import {
  buildModuleCtx,
  createActivity,
  createCourse,
  getModule,
  type RequestContext,
  toActivityRef,
  ValidationError,
} from '@hubium/core';
import { fileUrl, storeFile } from '@hubium/core/files/files';
import type { Prisma } from '@hubium/db';
import { sanitizeRichText } from '@hubium/editor/server';
import { type QuestionType, questionDataSchemas } from '@hubium/questions';
import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import tar from 'tar-stream';

// Moodle course backup (.mbz) import for Moodle 4.1–5.x: course, sections, the common
// activities, question bank and files. Anything unsupported becomes a label and is
// listed in the report.

type Node = Record<string, unknown>;
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
const num = (v: unknown, d = 0) => {
  const n = Number(txt(v));
  return Number.isFinite(n) ? n : d;
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
export async function readMbz(buf: Buffer): Promise<Archive> {
  const files: Archive = new Map();
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    for (const [k, v] of Object.entries(unzipSync(new Uint8Array(buf))))
      files.set(k.replace(/^\.\//, ''), Buffer.from(v));
    return files;
  }
  const raw = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
  const extract = tar.extract();
  await new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
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
  if (!files.has('moodle_backup.xml'))
    throw new ValidationError({ file: ['Not a Moodle backup: moodle_backup.xml is missing'] });
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

function mapMoodleQuestion(q: Node): { type: QuestionType; data: unknown } | null {
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
    default:
      return null;
  }
}

// ── import ───────────────────────────────────────────────────────────────────

export async function importMbz(
  ctx: RequestContext,
  archive: Archive,
  target: { categoryId: string; fullName?: string; shortName?: string },
): Promise<MbzReport> {
  const warnings: string[] = [];
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
    sections: Math.max(0, sections.length - 1),
    startDate: date(courseXml.startdate) ?? undefined,
    endDate: date(courseXml.enddate) ?? undefined,
  });
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
    data: { summary: rewrite(txt(courseXml.summary), summaryFiles) },
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
          name: name || 'Импорт',
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
      for (const g of groups) {
        for (const q of g.questions) {
          const mapped = mapMoodleQuestion(q);
          const name = txt(q.name) || 'Вопрос';
          if (!mapped) {
            warnings.push(`Question "${name}": type ${txt(q.qtype)} is not supported`);
            continue;
          }
          const parsed = questionDataSchemas[mapped.type].safeParse(mapped.data);
          if (!parsed.success) {
            warnings.push(`Question "${name}": ${parsed.error.issues[0]?.message ?? 'invalid'}`);
            continue;
          }
          const created2 = await db.question.create({
            data: {
              categoryId: fallbackCategory,
              type: mapped.type,
              name: name.slice(0, 255),
              text: sanitizeRichText(txt(q.questiontext)),
              generalFeedback: sanitizeRichText(txt(q.generalfeedback)),
              defaultMark: mapped.type === 'DESCRIPTION' ? 0 : num(q.defaultmark, 1),
              penalty: Math.min(1, Math.max(0, num(q.penalty))),
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
    const base = {
      courseId,
      sectionId,
      name,
      intro,
      showIntro: txt(module.showdescription) === '1',
      visibility: txt(module.visible) === '0' ? ('HIDDEN' as const) : ('SHOWN' as const),
    };
    const placeholder = async (why: string) => {
      warnings.push(`"${name}" (${modname}): ${why}`);
      await createActivity.run(ctx, {
        ...base,
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
          await createActivity.run(ctx, { ...base, moduleKey: 'page', settings: { content } });
          break;
        }
        case 'label':
          await createActivity.run(ctx, {
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
          await createActivity.run(ctx, {
            ...base,
            moduleKey: 'url',
            settings: { url, display: 'newtab' },
          });
          break;
        }
        case 'resource':
        case 'folder': {
          const { id } = await createActivity.run(ctx, {
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
          const grade = num(data.grade, 100);
          await createActivity.run(ctx, {
            ...base,
            moduleKey: 'assign',
            settings: {
              openAt: date(data.allowsubmissionsfromdate),
              dueAt: date(data.duedate),
              cutoffAt: date(data.cutoffdate),
              gradeMax: grade > 0 ? grade : 100,
              submitButton: txt(data.submissiondrafts) === '1',
            },
          });
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
          const { id } = await createActivity.run(ctx, {
            ...base,
            moduleKey: 'quiz',
            settings: {
              openAt: date(data.timeopen),
              closeAt: date(data.timeclose),
              timeLimitMin: Math.round(num(data.timelimit) / 60),
              attempts: num(data.attempts),
              gradeMethod: methods[txt(data.grademethod)] ?? 'HIGHEST',
              gradeMax: grade > 0 ? grade : 10,
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
                const cid = String(fc.questioncategoryid ?? fc.filter?.category?.values?.[0] ?? '');
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
          await createActivity.run(ctx, {
            ...base,
            moduleKey: 'forum',
            settings: { type: type === 'qanda' ? 'qanda' : 'general' },
          });
          break;
        }
        case 'scorm': {
          const pkg = files.find(
            (x) =>
              x.contextid === contextid && x.component === 'mod_scorm' && x.filearea === 'package',
          );
          const b = pkg && blob(pkg);
          if (!b || !getModule('scorm')) {
            await placeholder('SCORM package file is missing');
            continue;
          }
          const { id } = await createActivity.run(ctx, {
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
        case 'bigbluebuttonbn': {
          if (!getModule('livesession')) {
            await placeholder('live sessions are not installed');
            continue;
          }
          const start = date(data.openingtime) ?? new Date(Date.now() + 86_400_000).toISOString();
          const close = num(data.closingtime);
          await createActivity.run(ctx, {
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
  return {
    courseId,
    moodleRelease: txt(info.moodle_release),
    sections: sections.length,
    activities: activityCount,
    questions: questionCount,
    files: fileCount,
    warnings,
  };
}
