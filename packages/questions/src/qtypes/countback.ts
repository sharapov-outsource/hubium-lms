/**
 * Moodle's countback for questions made of parts that are right or wrong (matching,
 * gaps): each part right in the last response scores 1 less the penalty for every try
 * up to the last one it was wrong in; the grade is the average over the parts.
 */
export function countbackByParts(responses: boolean[][], penalty: number): number {
  const total = Math.max(0, ...responses.map((p) => p.length));
  if (!total || !responses.length) return 0;
  let score = 0;
  for (let k = 0; k < total; k++) {
    let lastWrong = -1;
    for (const [i, p] of responses.entries()) if (!p[k]) lastWrong = i;
    if (lastWrong < responses.length - 1) score += Math.max(0, 1 - (lastWrong + 1) * penalty);
  }
  return score / total;
}
