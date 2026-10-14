/** Feedback for how right the whole response is (Moodle's combined feedback). */
export function combinedFeedback(
  d: { feedbackCorrect: string; feedbackPartial: string; feedbackIncorrect: string },
  fraction: number,
): string[] {
  const text =
    fraction >= 1 - 1e-9
      ? d.feedbackCorrect
      : fraction > 0
        ? d.feedbackPartial
        : d.feedbackIncorrect;
  return text ? [text] : [];
}
