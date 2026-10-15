import { rng, shuffle, subSeed } from '../random.ts';
import type { QuestionTypeDef, QuestionView } from '../registry.ts';
import type { OrderingGrading } from '../types.ts';
import { combinedFeedback } from './combined.ts';

// Ordering, as Moodle's: put the items in order. An attempt shows all items or a drawn
// subset, never already in the right order, and the order is graded one of eight ways.

type View = QuestionView<'ORDERING'>;

/** The items of the attempt as shown (all, or the ones drawn). */
const shownOrder = (q: View) => q.order ?? q.data.items.map((i) => i.id);

/** The items of the attempt in the right order. */
function rightOrder(q: View): string[] {
  const shown = new Set(shownOrder(q));
  return q.data.items.map((i) => i.id).filter((id) => shown.has(id));
}

/**
 * The learner's order: the response, with any items it leaves out after it in the order
 * shown (all of them while the learner has not moved anything).
 */
function currentOrder(q: View, order: unknown): string[] {
  const shown = shownOrder(q);
  const valid = new Set(shown);
  const out: string[] = [];
  for (const id of Array.isArray(order) ? order : [])
    if (typeof id === 'string' && valid.has(id) && !out.includes(id)) out.push(id);
  return [...out, ...shown.filter((id) => !out.includes(id))];
}

/** Each item's next one; with `last`, the last item's "next" is the end (''). */
function nextOf(ids: string[], last: boolean): Map<string, string> {
  const m = new Map<string, string>();
  ids.forEach((id, i) => {
    if (i < ids.length - 1) m.set(id, ids[i + 1]!);
    else if (last) m.set(id, '');
  });
  return m;
}

/** Each item's neighbours: the one before and after ('' at the ends), or all of them. */
function neighbours(ids: string[], all: boolean) {
  const m = new Map<string, { prev: string[]; next: string[] }>();
  ids.forEach((id, i) => {
    m.set(
      id,
      all
        ? { prev: ids.slice(0, i).reverse(), next: ids.slice(i + 1) }
        : { prev: [ids[i - 1] ?? ''], next: [ids[i + 1] ?? ''] },
    );
  });
  return m;
}

const common = (a: string[], b: string[]) => a.filter((x) => b.includes(x)).length;

/**
 * Positions (in the learner's order) of the longest run of items in the right relative
 * order: any such items, or with `contiguous` items next to each other in the right
 * order. A single item does not count.
 */
function orderedSubset(right: string[], current: string[], contiguous: boolean): number[] {
  const pos = current.map((id) => right.indexOf(id));
  let best: number[] = [];
  if (contiguous) {
    const at = new Map(pos.map((p, i) => [p, i]));
    pos.forEach((p, i) => {
      if (p < 0) return;
      const run = [i];
      for (let v = p + 1, last = i; at.has(v) && at.get(v)! > last; v++) {
        last = at.get(v)!;
        run.push(last);
      }
      if (run.length > best.length) best = run;
    });
  } else {
    // longest increasing subsequence, the leftmost when there are several
    const len = pos.map(() => 1);
    const prev = pos.map(() => -1);
    pos.forEach((p, i) => {
      if (p < 0) return;
      for (let j = 0; j < i; j++)
        if (pos[j]! >= 0 && pos[j]! < p && len[j]! + 1 > len[i]!) {
          len[i] = len[j]! + 1;
          prev[i] = j;
        }
    });
    let end = -1;
    pos.forEach((p, i) => {
      if (p >= 0 && (end < 0 || len[i]! > len[end]!)) end = i;
    });
    for (let i = end; i >= 0; i = prev[i]!) best.unshift(i);
  }
  return best.length >= 2 ? best : [];
}

/** Points earned and possible for an order (Moodle's grade_response). */
function orderScore(right: string[], current: string[], g: OrderingGrading) {
  let got = 0;
  let max = 0;
  switch (g) {
    case 'allOrNothing':
    case 'absolutePosition':
      right.forEach((id, p) => {
        if (current[p] === id) got++;
        max++;
      });
      if (g === 'allOrNothing' && got < max) got = 0;
      break;
    case 'relativeNextExcludeLast':
    case 'relativeNextIncludeLast': {
      const last = g === 'relativeNextIncludeLast';
      const want = nextOf(right, last);
      const have = nextOf(current, last);
      for (const [id, next] of want) {
        if (have.has(id) && have.get(id) === next) got++;
        max++;
      }
      break;
    }
    case 'relativeOnePreviousAndNext':
    case 'relativeAllPreviousAndNext': {
      const all = g === 'relativeAllPreviousAndNext';
      const want = neighbours(right, all);
      const have = neighbours(current, all);
      for (const [id, w] of want) {
        const h = have.get(id);
        if (h) got += common(h.prev, w.prev) + common(h.next, w.next);
        max += w.prev.length + w.next.length;
      }
      break;
    }
    case 'longestOrderedSubset':
    case 'longestContiguousSubset':
      got = orderedSubset(right, current, g === 'longestContiguousSubset').length;
      max = current.length;
      break;
    case 'relativeToCorrect': {
      const n = right.length - 1;
      right.forEach((id, p) => {
        const at = current.indexOf(id);
        if (at >= 0) got += Math.max(0, n - Math.abs(p - at));
        max += n;
      });
      break;
    }
  }
  return { got, max, fraction: max ? got / max : 0 };
}

/** How each item of the learner's order scored: 0..1, or null when it is not scored. */
function itemScores(right: string[], current: string[], g: OrderingGrading): (number | null)[] {
  switch (g) {
    case 'allOrNothing':
    case 'absolutePosition':
      return current.map((id, p) => (p < right.length ? (right[p] === id ? 1 : 0) : null));
    case 'relativeNextExcludeLast':
    case 'relativeNextIncludeLast': {
      const last = g === 'relativeNextIncludeLast';
      const want = nextOf(right, last);
      const have = nextOf(current, last);
      return current.map((id) => (want.has(id) ? (have.get(id) === want.get(id) ? 1 : 0) : null));
    }
    case 'relativeOnePreviousAndNext':
    case 'relativeAllPreviousAndNext': {
      const all = g === 'relativeAllPreviousAndNext';
      const want = neighbours(right, all);
      const have = neighbours(current, all);
      return current.map((id) => {
        const w = want.get(id);
        const h = have.get(id);
        if (!w || !h) return null;
        const max = w.prev.length + w.next.length;
        return max ? (common(w.prev, h.prev) + common(w.next, h.next)) / max : 0;
      });
    }
    case 'longestOrderedSubset':
    case 'longestContiguousSubset': {
      const subset = new Set(orderedSubset(right, current, g === 'longestContiguousSubset'));
      return current.map((_, p) => (p < right.length ? (subset.has(p) ? 1 : 0) : null));
    }
    case 'relativeToCorrect': {
      const n = right.length - 1;
      return current.map((id, p) => {
        const at = right.indexOf(id);
        if (at < 0 || !n) return null;
        return Math.max(0, n - Math.abs(at - p)) / n;
      });
    }
  }
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export const ordering: QuestionTypeDef<'ORDERING'> = {
  type: 'ORDERING',
  grading: 'auto',
  present(q, seed) {
    const ids = q.data.items.map((i) => i.id);
    const n = ids.length;
    const count = q.data.select === 'all' ? n : Math.min(n, Math.max(2, q.data.selectCount));
    let drawn = ids;
    if (count < n && q.data.select === 'random') {
      const pick = new Set(shuffle(ids, subSeed(seed, 3)).slice(0, count));
      drawn = ids.filter((id) => pick.has(id));
    } else if (count < n) {
      const start = Math.floor(rng(subSeed(seed, 5))() * (n - count + 1));
      drawn = ids.slice(start, start + count);
    }
    // never shown in the right order already
    let shown = shuffle(drawn, seed);
    for (let k = 1; same(shown, drawn) && k < 10; k++)
      shown = shuffle(drawn, subSeed(seed, 100 + k));
    if (same(shown, drawn)) shown = [...drawn.slice(1), drawn[0]!];
    return { order: shown };
  },
  grade(q, r) {
    const { fraction } = orderScore(rightOrder(q), currentOrder(q, r.order), q.data.grading);
    return { fraction, needsGrading: false, feedback: combinedFeedback(q.data, fraction) };
  },
  correctResponse: (q) => ({ order: rightOrder(q) }),
  isAnswered: (r) => Array.isArray(r.order) && r.order.length > 0,
  answerText(q, r) {
    const text = new Map(q.data.items.map((i) => [i.id, i.text]));
    return currentOrder(q, r.order)
      .map((id) => text.get(id) ?? '?')
      .join(' → ');
  },
  publicView(q) {
    const byId = new Map(q.data.items.map((i) => [i.id, i]));
    return {
      orderItems: shownOrder(q)
        .map((id) => byId.get(id))
        .filter((i) => !!i)
        .map((i) => ({ id: i.id, text: i.text })),
      orderLayout: q.data.layout,
      orderNumbering: q.data.numbering,
    };
  },
  parts(q, r) {
    const scores = itemScores(rightOrder(q), currentOrder(q, r.order), q.data.grading);
    return {
      right: scores.filter((s) => s !== null && s > 0.999999).length,
      total: scores.filter((s) => s !== null).length,
    };
  },
  // an order has no parts to clear: the next try starts from the learner's order
  clearWrong: (_q, r) => r,
  reviewParts(q, r) {
    if (!q.data.showGrading) return null;
    const text = new Map(q.data.items.map((i) => [i.id, i.text]));
    const current = currentOrder(q, r.order);
    const scores = itemScores(rightOrder(q), current, q.data.grading);
    return current.map((id, i) => ({ text: text.get(id) ?? '?', fraction: scores[i] ?? null }));
  },
};
