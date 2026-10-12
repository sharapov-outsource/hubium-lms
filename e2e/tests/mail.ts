// Mailpit helpers (http://localhost:8025).
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

interface MailSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Created: string;
}

export async function waitForMail(
  to: string,
  opts: { subject?: RegExp; timeoutMs?: number; after?: Date } = {},
) {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const data = (await r.json()) as { messages: MailSummary[] };
    const m = data.messages.find(
      (x) =>
        (!opts.subject || opts.subject.test(x.Subject)) &&
        (!opts.after || new Date(x.Created) >= opts.after),
    );
    if (m) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as {
        Text: string;
        HTML: string;
        Subject: string;
      };
      return full;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`No mail for ${to}`);
}

export function firstLink(text: string): string {
  const m = /(https?:\/\/[^\s"<>]+)/.exec(text);
  if (!m) throw new Error('No link in mail');
  return m[1]!;
}
