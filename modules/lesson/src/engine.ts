// The lesson's rules, as Moodle's, without the database: where a jump leads, which answers
// count as correct, how an answer to each kind of question is checked, and the grade of
// an attempt. Pure, so the server and the tests share them.

import { wildcardMatch } from '@hubium/questions';

export const pageTypes = [
  'content',
  'multichoice',
  'truefalse',
  'shortanswer',
  'numerical',
  'matching',
  'essay',
  'endofbranch',
  'cluster',
  'endofcluster',
] as const;
export type PageType = (typeof pageTypes)[number];

export const questionTypes: readonly PageType[] = [
  'multichoice',
  'truefalse',
  'shortanswer',
  'numerical',
  'matching',
  'essay',
];
/** Pages the learner never sees: they only lead on. */
const structureTypes: readonly PageType[] = ['endofbranch', 'cluster', 'endofcluster'];

export const isQuestion = (t: string) => questionTypes.includes(t as PageType);
export const isStructure = (t: string) => structureTypes.includes(t as PageType);

/**
 * Where an answer leads: a page id, or one of these. `unseenBranch` and `randomBranch` pick
 * a question of the current content page's branch (one not answered yet, or any);
 * `randomContent` a content page not seen yet; `unseenCluster` a question of the cluster
 * not answered yet; `lastContent` the content page seen last.
 */
export const jumpKeywords = [
  'this',
  'next',
  'previous',
  'end',
  'unseenBranch',
  'randomBranch',
  'randomContent',
  'unseenCluster',
  'lastContent',
] as const;

export interface Answer {
  id: string;
  /** A button's label, an option, a pattern ("*" any text), a number or "min:max". */
  text: string;
  /** Shown after the answer. */
  response: string;
  jump: string;
  /** Points with custom scoring. */
  score: number;
}

export interface Page {
  id: string;
  type: PageType;
  answers: Answer[];
  options: {
    multiple?: boolean;
    caseSensitive?: boolean;
    pairs?: { left: string; right: string }[];
  };
}

/** What happened in the attempt so far, oldest first. */
export interface Step {
  pageId: string;
  kind: 'view' | 'answer';
  correct: boolean;
}

export const END = 'end';

/** Picks one of the items (the server passes Math.random; tests a fixed choice). */
export type Pick = <T>(items: T[]) => T;

const at = (pages: Page[], id: string) => pages.findIndex((p) => p.id === id);
const answered = (steps: Step[]) =>
  new Set(steps.filter((s) => s.kind === 'answer').map((s) => s.pageId));
const seen = (steps: Step[]) => new Set(steps.map((s) => s.pageId));

/** The page after `i` in order, or the end. */
const after = (pages: Page[], i: number) => pages[i + 1]?.id ?? END;

/**
 * The branch of a page: from the nearest content page at or before it to the end of the
 * branch (or the next content page). Null when no content page comes before.
 */
function branchOf(pages: Page[], id: string): { start: number; end: number } | null {
  let start = at(pages, id);
  while (start >= 0 && pages[start]!.type !== 'content') start--;
  if (start < 0) return null;
  let end = start + 1;
  while (end < pages.length && pages[end]!.type !== 'content' && pages[end]!.type !== 'endofbranch')
    end++;
  // `end` is the end of branch page (or the page after the branch)
  return { start, end };
}

/** The cluster around a page: from its cluster page to its end of cluster (or the end). */
function clusterOf(pages: Page[], id: string): { start: number; end: number } | null {
  let start = at(pages, id);
  while (start >= 0 && pages[start]!.type !== 'cluster') {
    if (pages[start]!.type === 'endofcluster' && pages[start]!.id !== id) return null;
    start--;
  }
  if (start < 0) return null;
  let end = start + 1;
  while (end < pages.length && pages[end]!.type !== 'endofcluster') end++;
  return { start, end };
}

const questionsIn = (pages: Page[], from: number, to: number) =>
  pages.slice(from, to).filter((p) => isQuestion(p.type));

/** Where a jump from page `fromId` leads: a page id or END. */
export function resolveJump(
  pages: Page[],
  fromId: string,
  jump: string,
  steps: Step[],
  pick: Pick,
): string {
  const i = at(pages, fromId);
  switch (jump) {
    case 'this':
      return fromId;
    case 'next':
      return after(pages, i);
    case 'previous':
      return pages[i - 1]?.id ?? fromId;
    case 'end':
      return END;
    case 'unseenBranch':
    case 'randomBranch': {
      const b = branchOf(pages, fromId);
      if (!b) return after(pages, i);
      const done = answered(steps);
      const qs = questionsIn(pages, b.start + 1, b.end).filter(
        (p) => jump === 'randomBranch' || !done.has(p.id),
      );
      // every question of the branch answered: on past the branch
      if (qs.length) return pick(qs).id;
      return pages[b.end]?.type === 'endofbranch' ? after(pages, b.end) : (pages[b.end]?.id ?? END);
    }
    case 'randomContent': {
      const contents = pages.filter((p) => p.type === 'content');
      const visited = seen(steps);
      const fresh = contents.filter((p) => !visited.has(p.id));
      const pool = fresh.length ? fresh : contents;
      return pool.length ? pick(pool).id : END;
    }
    case 'unseenCluster': {
      const c = clusterOf(pages, fromId);
      if (!c) return after(pages, i);
      const done = answered(steps);
      const qs = questionsIn(pages, c.start + 1, c.end).filter((p) => !done.has(p.id));
      return qs.length ? pick(qs).id : after(pages, c.end);
    }
    case 'lastContent': {
      for (let k = steps.length - 1; k >= 0; k--) {
        const p = pages[at(pages, steps[k]!.pageId)];
        if (p?.type === 'content') return p.id;
      }
      const b = branchOf(pages, fromId);
      return b ? pages[b.start]!.id : after(pages, i);
    }
    default:
      // a page that is gone leads on
      return at(pages, jump) >= 0 ? jump : after(pages, i);
  }
}

/**
 * The page the learner lands on: structural pages (cluster, end of branch, end of
 * cluster) are passed through by their jump.
 */
export function landOn(pages: Page[], id: string, steps: Step[], pick: Pick): string {
  let cur = id;
  for (let n = 0; n < pages.length + 1 && cur !== END; n++) {
    const p = pages[at(pages, cur)];
    if (!p) return END;
    if (!isStructure(p.type)) return cur;
    const jump = p.answers[0]?.jump ?? defaultStructureJump(p.type);
    const next = resolveJump(pages, cur, jump, steps, pick);
    // a structural page that leads to itself would loop: on to the next page
    cur = next === cur ? after(pages, at(pages, cur)) : next;
  }
  // only structural pages leading to each other: the lesson is over
  return END;
}

export function defaultStructureJump(type: PageType): string {
  return type === 'cluster' ? 'unseenCluster' : type === 'endofbranch' ? 'lastContent' : 'next';
}

/**
 * Is an answer leading there correct, when the lesson does not score answers itself?
 * Moodle's rule: forward is correct; this page, back and elsewhere are not.
 */
export function jumpIsCorrect(pages: Page[], fromId: string, jump: string): boolean {
  if (['next', 'end', 'unseenBranch', 'randomBranch', 'unseenCluster'].includes(jump)) return true;
  if ((jumpKeywords as readonly string[]).includes(jump)) return false;
  return at(pages, jump) > at(pages, fromId);
}

const answerIsCorrect = (custom: boolean, pages: Page[], page: Page, a: Answer) =>
  custom ? a.score > 0 : jumpIsCorrect(pages, page.id, a.jump);

/** Does a short answer match a pattern ("*" stands for any text)? */
export function matchesPattern(given: string, pattern: string, caseSensitive: boolean): boolean {
  const norm = (s: string) => {
    const t = s.trim().replace(/\s+/g, ' ');
    return caseSensitive ? t : t.toLocaleLowerCase();
  };
  return wildcardMatch(norm(pattern), norm(given));
}

/** A number as people write it ("3,5" too); NaN for anything else. */
export function readNumber(text: string): number {
  const t = text.trim().replace(/\s/g, '').replace(',', '.');
  return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : Number.NaN;
}

/** Does a number answer a numerical answer ("5", or a range "4.5:5.5")? */
export function matchesNumber(given: number, answer: string): boolean {
  if (!Number.isFinite(given)) return false;
  const [lo, hi] = answer.split(':').map((v) => readNumber(v));
  if (hi === undefined) return Number.isFinite(lo!) && Math.abs(given - lo!) < 1e-9;
  return Number.isFinite(lo!) && Number.isFinite(hi) && given >= lo! - 1e-9 && given <= hi + 1e-9;
}

export type Response =
  | { choice: string }
  | { choices: string[] }
  | { text: string }
  | { matches: string[] };

export interface Checked {
  correct: boolean;
  /** The answer whose jump, response and score apply; null when nothing matched. */
  answer: Answer | null;
  score: number;
}

/**
 * Checks a response to a question page. Essays are not checked: they wait for a teacher
 * (`correct` false, the one answer's jump).
 */
export function checkResponse(pages: Page[], page: Page, r: Response, custom: boolean): Checked {
  const right = (a: Answer) => answerIsCorrect(custom, pages, page, a);
  const of = (a: Answer | null | undefined): Checked =>
    a ? { correct: right(a), answer: a, score: custom ? a.score : 0 } : wrong;
  const wrong: Checked = { correct: false, answer: null, score: 0 };
  switch (page.type) {
    case 'truefalse':
      return 'choice' in r ? of(page.answers.find((a) => a.id === r.choice)) : wrong;
    case 'multichoice': {
      if (!page.options.multiple)
        return 'choice' in r ? of(page.answers.find((a) => a.id === r.choice)) : wrong;
      if (!('choices' in r)) return wrong;
      const chosen = new Set(r.choices);
      const corrects = page.answers.filter(right);
      const allRight =
        corrects.length > 0 &&
        corrects.every((a) => chosen.has(a.id)) &&
        page.answers.every((a) => right(a) || !chosen.has(a.id));
      if (allRight)
        return {
          correct: true,
          answer: corrects[0]!,
          score: custom ? corrects.reduce((s, a) => s + a.score, 0) : 0,
        };
      const lead =
        page.answers.find((a) => !right(a) && chosen.has(a.id)) ??
        page.answers.find((a) => !right(a)) ??
        null;
      return { correct: false, answer: lead, score: 0 };
    }
    case 'shortanswer': {
      if (!('text' in r) || !r.text.trim()) return wrong;
      return of(
        page.answers.find((a) => matchesPattern(r.text, a.text, !!page.options.caseSensitive)),
      );
    }
    case 'numerical': {
      if (!('text' in r)) return wrong;
      const n = readNumber(r.text);
      return of(page.answers.find((a) => matchesNumber(n, a.text)));
    }
    case 'matching': {
      const pairs = page.options.pairs ?? [];
      const [ok, ko] = page.answers;
      const all =
        'matches' in r && pairs.length > 0 && pairs.every((p, k) => r.matches[k] === p.right);
      return all
        ? { correct: true, answer: ok ?? null, score: custom ? (ok?.score ?? 0) : 0 }
        : { correct: false, answer: ko ?? null, score: 0 };
    }
    case 'essay':
      return { correct: false, answer: page.answers[0] ?? null, score: 0 };
    default:
      return wrong;
  }
}

/** A graded step of an attempt: an answer to a question. */
export interface AnswerStep {
  pageId: string;
  correct: boolean;
  score: number;
  /** Essays: the teacher's points, null until graded. */
  essayScore?: number | null;
}

export interface Grade {
  earned: number;
  total: number;
  /** 0..100; null when the lesson asks nothing. */
  percent: number | null;
  /** Essays not graded yet. */
  pending: number;
}

/**
 * The grade of an attempt, as Moodle reckons it. Without custom scoring every try counts:
 * the correct ones earn a point each, out of all tries (up to the allowed number per
 * question), and too few questions answered count as wrong ones. With custom scoring the
 * last try of each question earns its answer's points, out of the best each answered
 * question offers.
 */
export function attemptGrade(
  pages: Page[],
  steps: AnswerStep[],
  s: { custom: boolean; maxAttempts: number; minQuestions: number },
): Grade {
  const byPage = new Map<string, AnswerStep[]>();
  for (const st of steps) {
    const list = byPage.get(st.pageId) ?? [];
    if (list.length < s.maxAttempts) list.push(st);
    byPage.set(st.pageId, list);
  }
  const essays = (id: string) => pages.find((p) => p.id === id)?.type === 'essay';
  let earned = 0;
  let total = 0;
  let tries = 0;
  let pending = 0;
  for (const [pageId, list] of byPage) {
    const last = list[list.length - 1]!;
    const essay = essays(pageId);
    if (essay && (last.essayScore === null || last.essayScore === undefined)) pending++;
    if (s.custom) {
      const page = pages.find((p) => p.id === pageId);
      total += Math.max(0, ...(page?.answers.map((a) => a.score) ?? [0]));
      earned += essay ? (last.essayScore ?? 0) : last.score;
    } else {
      earned += list.filter((x) => (essays(pageId) ? (x.essayScore ?? 0) > 0 : x.correct)).length;
      tries += list.length;
    }
  }
  if (!s.custom) total = tries + Math.max(0, s.minQuestions - byPage.size);
  const asks = pages.some((p) => isQuestion(p.type));
  const percent =
    total > 0 ? Math.round((earned / total) * 100 * 100_000) / 100_000 : asks ? 0 : null;
  return {
    earned,
    total,
    percent: percent === null ? null : Math.max(0, Math.min(100, percent)),
    pending,
  };
}

/** The grade from a learner's finished attempts: the best, or their mean. */
export function lessonPercent(percents: (number | null)[], useMax: boolean): number | null {
  const xs = percents.filter((p): p is number => p !== null);
  if (!xs.length) return null;
  return useMax ? Math.max(...xs) : xs.reduce((a, b) => a + b, 0) / xs.length;
}
