import { certificateDetail, csvEscape } from '@hubium/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getContext } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Who a certificate was issued to, as CSV: the issue report to keep or hand over. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response('Not found', { status: 404 });
  const d = await certificateDetail(await getContext(), id).catch(() => null);
  if (!d) return new Response('Forbidden', { status: 403 });
  const [t, format] = await Promise.all([getTranslations('certificates'), getFormatter()]);
  const date = (x: Date | null) =>
    x ? format.dateTime(x, { dateStyle: 'short', timeStyle: 'short' }) : '';
  const rows = [
    [t('recipient'), 'Email', t('code'), t('issued'), t('revoked'), t('revokeReason')],
    ...d.issues.map((i) => [
      i.user.name,
      i.user.email,
      i.code,
      date(i.issuedAt),
      date(i.revokedAt),
      i.revokedReason ?? '',
    ]),
  ];
  const csv = `﻿${rows.map((r) => r.map(csvEscape).join(',')).join('\r\n')}\r\n`;
  const name = `${d.certificate.name}.csv`.replace(/[\\/:*?"<>|]+/g, ' ');
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
}
