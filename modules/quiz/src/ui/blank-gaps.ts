// Shared by the server-rendered review: not a client module.

/** The question text with its gaps ([[1]], [[2]], …) shown as numbered blanks. */
export function blankGaps(html: string): string {
  return html.replace(
    /\[\[(\d+)\]\]/g,
    (_, n: string) =>
      `<span class="mx-0.5 inline-block min-w-12 border-b-2 border-dashed border-muted-foreground text-center text-xs text-muted-foreground">${Number(n)}</span>`,
  );
}
