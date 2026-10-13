// A small scanner for the XML inside office documents (machine-written and well-formed):
// start and end tags with their raw attributes, and the text between them. It needs no DOM,
// so a large document costs one pass over the string.

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Replaces the predefined entities and character references. */
export function decodeXml(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] !== '#') return NAMED[e] ?? m;
    const code =
      e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/** Value of one attribute in a tag's raw attribute string. */
export function attr(attrs: string, name: string): string | null {
  const m = new RegExp(
    `(?:^|\\s)${name.replace(/[.:-]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
  ).exec(attrs);
  return m ? decodeXml(m[1] ?? m[2] ?? '') : null;
}

export interface XmlHandler {
  open?(name: string, attrs: string, selfClosing: boolean): void;
  close?(name: string): void;
  text?(text: string): void;
}

const TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;

/** Calls the handler for every tag and text run in document order. */
export function walkXml(xml: string, h: XmlHandler): void {
  for (const m of xml.matchAll(TOKEN)) {
    const [, cdata, slash, name, rawAttrs, text] = m;
    if (text !== undefined) h.text?.(decodeXml(text));
    else if (cdata !== undefined) h.text?.(cdata);
    else if (name !== undefined) {
      if (slash) h.close?.(name);
      else {
        const selfClosing = rawAttrs!.endsWith('/');
        h.open?.(name, selfClosing ? rawAttrs!.slice(0, -1) : rawAttrs!, selfClosing);
        if (selfClosing) h.close?.(name);
      }
    }
  }
}

/** Collapses spaces inside a block and trims it. */
export const tidy = (s: string) =>
  s
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
