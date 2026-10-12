import { Badge, Card, CardContent, PageHeader, Table, TBody, Td, Th, Tr } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { requireCapability } from '@/server/session';

export default async function EnvironmentPage() {
  await requireCapability('site:config');
  const t = await getTranslations('admin.env');
  const [pg] = await db.$queryRaw<
    { version: string }[]
  >`SELECT current_setting('server_version') AS version`;
  const jobs = await db.$queryRaw<
    { n: bigint }[]
  >`SELECT count(*)::bigint AS n FROM pgboss.job WHERE state IN ('created','retry')`.catch(() => [
    { n: -1n },
  ]);
  const rows: [string, React.ReactNode][] = [
    [t('version'), process.env.npm_package_version ?? '0.1.0'],
    [t('appUrl'), process.env.APP_URL ?? '—'],
    [t('node'), process.version],
    [t('database'), pg?.version ?? '—'],
    [t('storage'), process.env.STORAGE_DRIVER ?? 'fs'],
    [t('smtp'), (process.env.SMTP_URL ?? 'smtp://localhost:1025').replace(/\/\/[^@]*@/, '//***@')],
    [
      t('jobs'),
      Number(jobs[0]?.n ?? 0) >= 0 ? (
        <Badge key="ok" variant="success">
          pg-boss · {String(jobs[0]?.n ?? 0)} queued
        </Badge>
      ) : (
        <Badge key="no" variant="warning">
          not initialised
        </Badge>
      ),
    ],
  ];
  return (
    <>
      <PageHeader title={t('title')} />
      <Card>
        <CardContent className="pt-5">
          <Table>
            <TBody>
              {rows.map(([k, v]) => (
                <Tr key={k}>
                  <Th className="w-56">{k}</Th>
                  <Td className="font-mono text-sm">{v}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
