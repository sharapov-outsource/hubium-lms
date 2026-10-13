import { environmentChecks } from '@hubium/core';
import { Badge, Card, CardContent, PageHeader, Table, TBody, Td, THead, Th, Tr } from '@hubium/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import { buildInfo } from '@/lib/build-info';
import { db } from '@/server/db';
import { requireCapability } from '@/server/session';

export const dynamic = 'force-dynamic';

const variant = { ok: 'success', warn: 'warning', error: 'destructive' } as const;

export default async function EnvironmentPage() {
  await requireCapability('site:config');
  const t = await getTranslations('admin.env');
  const [checks, format] = await Promise.all([environmentChecks(db), getFormatter()]);
  const info: [string, string][] = [
    [t('version'), buildInfo.version],
    [t('commit'), buildInfo.commit ?? '—'],
    [
      t('builtAt'),
      buildInfo.builtAt
        ? format.dateTime(new Date(buildInfo.builtAt), { dateStyle: 'medium', timeStyle: 'short' })
        : '—',
    ],
    [t('appUrl'), process.env.APP_URL ?? '—'],
    [t('node'), process.version],
    [t('storage'), process.env.STORAGE_DRIVER ?? 'fs'],
  ];
  return (
    <>
      <PageHeader title={t('title')} />
      <div className="grid gap-6">
        <Card>
          <CardContent className="pt-5">
            <Table>
              <THead>
                <Tr>
                  <Th className="w-48">{t('check')}</Th>
                  <Th className="w-28">{t('status')}</Th>
                  <Th>{t('detail')}</Th>
                </Tr>
              </THead>
              <TBody>
                {checks.map((c) => (
                  <Tr key={c.key}>
                    <Td>{t(`checks.${c.key}`)}</Td>
                    <Td>
                      <Badge variant={variant[c.status]}>{t(`statuses.${c.status}`)}</Badge>
                    </Td>
                    <Td className="break-all font-mono text-xs">{c.detail}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <Table>
              <TBody>
                {info.map(([k, v]) => (
                  <Tr key={k}>
                    <Th className="w-48">{k}</Th>
                    <Td className="font-mono text-sm">{v}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
