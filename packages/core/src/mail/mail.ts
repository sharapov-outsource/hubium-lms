import { createTranslator, type Locale } from '@hubium/i18n';
import nodemailer, { type Transporter } from 'nodemailer';
import { enqueue } from '../jobs/jobs.ts';

let transport: Transporter | undefined;

export function setMailTransport(t: Transporter | undefined): void {
  transport = t;
}

export function getTransport(): Transporter {
  transport ??= nodemailer.createTransport(process.env.SMTP_URL ?? 'smtp://localhost:1025');
  return transport;
}

export async function deliverMail(m: {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}) {
  const from = process.env.MAIL_FROM ?? 'Hubium LMS <no-reply@hubium.local>';
  return getTransport().sendMail({ from, ...m });
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

interface Link {
  label: string;
  url: string;
}

const layout = (siteName: string, inner: string, footer: string, unsub?: Link) =>
  `<!doctype html><html><body style="margin:0;background:#f7f7f8;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1b1d22"><div style="max-width:560px;margin:0 auto;padding:32px 16px"><div style="background:#fff;border:1px solid #e4e6ea;border-radius:12px;padding:28px"><p style="margin:0 0 16px;font-weight:600;color:#4f46e5">${escapeHtml(siteName)}</p>${inner}</div><p style="font-size:12px;color:#5d6370;text-align:center;margin-top:16px">${escapeHtml(footer)}${unsub ? ` · <a href="${escapeHtml(unsub.url)}" style="color:#5d6370">${escapeHtml(unsub.label)}</a>` : ''}</p></div></body></html>`;

/** Daily digest: a list of notifications with links. */
export function renderDigestEmail(opts: {
  siteName: string;
  heading: string;
  items: { title: string; body?: string; url?: string }[];
  footer: string;
  unsubscribe?: Link;
}): { html: string; text: string } {
  const li = opts.items
    .map((i) => {
      const title = i.url
        ? `<a href="${escapeHtml(i.url)}" style="color:#4f46e5;font-weight:600">${escapeHtml(i.title)}</a>`
        : `<strong>${escapeHtml(i.title)}</strong>`;
      const body = i.body
        ? `<div style="color:#5d6370;font-size:14px;margin-top:2px">${escapeHtml(i.body.slice(0, 300))}</div>`
        : '';
      return `<li style="margin:0 0 14px">${title}${body}</li>`;
    })
    .join('');
  const html = layout(
    opts.siteName,
    `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(opts.heading)}</h1><ul style="padding-left:18px;margin:0;line-height:1.5">${li}</ul>`,
    opts.footer,
    opts.unsubscribe,
  );
  const text = [
    opts.siteName,
    '',
    opts.heading,
    '',
    ...opts.items.map(
      (i) =>
        `- ${i.title}${i.body ? `: ${i.body.slice(0, 300)}` : ''}${i.url ? `\n  ${i.url}` : ''}`,
    ),
    '',
    opts.footer,
    ...(opts.unsubscribe ? [`${opts.unsubscribe.label}: ${opts.unsubscribe.url}`] : []),
  ].join('\n');
  return { html, text };
}

/** Simple, accessible, table-free email layout with one call-to-action button. */
export function renderActionEmail(opts: {
  siteName: string;
  heading: string;
  intro: string;
  action?: Link;
  footer: string;
  unsubscribe?: Link;
}): { html: string; text: string } {
  const button = opts.action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(opts.action.url)}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600">${escapeHtml(opts.action.label)}</a></p><p style="font-size:13px;color:#5d6370">${escapeHtml(opts.action.url)}</p>`
    : '';
  const html = layout(
    opts.siteName,
    `<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(opts.heading)}</h1><p style="line-height:1.6;margin:0">${escapeHtml(opts.intro)}</p>${button}`,
    opts.footer,
    opts.unsubscribe,
  );
  const text = [
    opts.siteName,
    '',
    opts.heading,
    '',
    opts.intro,
    ...(opts.action ? ['', `${opts.action.label}: ${opts.action.url}`] : []),
    '',
    opts.footer,
    ...(opts.unsubscribe ? [`${opts.unsubscribe.label}: ${opts.unsubscribe.url}`] : []),
  ].join('\n');
  return { html, text };
}

export type AuthEmailKind = 'verify' | 'reset' | 'changeEmail';

export async function sendAuthEmail(opts: {
  kind: AuthEmailKind;
  to: string;
  url: string;
  locale: Locale;
  siteName: string;
  name: string;
}): Promise<void> {
  const t = createTranslator(opts.locale);
  const { html, text } = renderActionEmail({
    siteName: opts.siteName,
    heading: t(`email.${opts.kind}.heading`),
    intro: t(`email.${opts.kind}.intro`, { name: opts.name }),
    action: { label: t(`email.${opts.kind}.action`), url: opts.url },
    footer: t('email.footer'),
  });
  await enqueue('email.send', {
    to: opts.to,
    subject: t(`email.${opts.kind}.subject`, { site: opts.siteName }),
    html,
    text,
    template: `auth.${opts.kind}`,
  });
}
