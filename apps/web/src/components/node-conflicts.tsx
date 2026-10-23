import type { Locale } from '@hubium/i18n';
import { msg } from '@hubium/module-sdk';
import { Badge, Table, TBody, Td, THead, Th, Tr } from '@hubium/ui';
import Link from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

/** Why the cloud did not take an entry, in the reader's language. */
export function conflictReason(reason: unknown, locale: Locale): string {
  const r = (reason ?? {}) as { key?: string; values?: Record<string, string | number> };
  if (!r.key) return '';
  try {
    return msg(r.key, r.values).in(locale);
  } catch {
    return r.key;
  }
}

export interface ConflictRow {
  id: string;
  name: string;
  status: string;
  reason: unknown;
  createdAt: Date;
  actorName: string | null;
  node: { name: string };
}

/** Conflicts of nodes' journals: when, where, whose, why, and what became of them. */
export async function ConflictsTable({ rows }: { rows: ConflictRow[] }) {
  const [t, format, locale] = await Promise.all([
    getTranslations('nodes'),
    getFormatter(),
    getLocale(),
  ]);
  if (!rows.length) return <p className="text-sm text-muted-foreground">{t('noConflicts')}</p>;
  return (
    <Table>
      <THead>
        <Tr>
          <Th className="w-40">{t('when')}</Th>
          <Th>{t('node')}</Th>
          <Th>{t('author')}</Th>
          <Th>{t('why')}</Th>
          <Th className="w-28">{t('status')}</Th>
        </Tr>
      </THead>
      <TBody>
        {rows.map((c) => (
          <Tr key={c.id}>
            <Td className="text-sm">
              <Link href={`/node-conflicts/${c.id}`} className="text-accent hover:underline">
                {format.dateTime(c.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
              </Link>
            </Td>
            <Td className="text-sm">{c.node.name}</Td>
            <Td className="text-sm">{c.actorName ?? '—'}</Td>
            <Td className="text-sm">{conflictReason(c.reason, locale as Locale)}</Td>
            <Td>
              <Badge
                variant={
                  c.status === 'OPEN' ? 'warning' : c.status === 'ACCEPTED' ? 'success' : 'neutral'
                }
              >
                {t(`conflictStatus.${c.status}`)}
              </Badge>
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}
