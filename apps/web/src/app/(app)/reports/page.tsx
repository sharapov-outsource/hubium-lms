import { listReports, SOURCE_KEYS } from '@hubium/core';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Select,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { createReportAction } from '@/server/actions/reports';
import { titled } from '@/server/page-title';
import { getContext, requireUser } from '@/server/session';

export const generateMetadata = titled('customReports', 'title');

/** The custom reports the viewer may see, and a new one for those who build them. */
export default async function ReportsPage() {
  await requireUser();
  const ctx = await getContext();
  const [t, tc, data] = await Promise.all([
    getTranslations('customReports'),
    getTranslations('common'),
    listReports(ctx),
  ]);
  return (
    <>
      <PageHeader title={t('title')} description={t('intro')} />
      <div className={data.customise ? 'grid gap-6 lg:grid-cols-[1fr_20rem]' : ''}>
        <div className="min-w-0">
          {data.reports.length === 0 ? (
            <EmptyState title={t('noReports')} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <Tr>
                    <Th>{t('name')}</Th>
                    <Th>{t('source')}</Th>
                    {data.customise ? (
                      <Th>
                        <span className="sr-only">{tc('actions')}</span>
                      </Th>
                    ) : null}
                  </Tr>
                </THead>
                <TBody>
                  {data.reports.map((r) => (
                    <Tr key={r.id}>
                      <Td>
                        <Link href={`/reports/${r.id}`} className="hover:underline">
                          {r.name}
                        </Link>
                      </Td>
                      <Td>{t(`sources.${r.source}`)}</Td>
                      {data.customise ? (
                        <Td className="text-right">
                          <Link
                            href={`/reports/${r.id}/edit`}
                            className="text-sm text-accent hover:underline"
                          >
                            {tc('edit')}
                          </Link>
                        </Td>
                      ) : null}
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </div>
        {data.customise ? (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>{t('new')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ActionForm action={createReportAction} className="grid gap-3">
                <FormField name="name" id="new-report-name" label={t('name')} required />
                <FormField name="source" id="new-report-source" label={t('source')}>
                  <Select id="new-report-source" name="source" defaultValue="users">
                    {SOURCE_KEYS.map((s) => (
                      <option key={s} value={s}>
                        {t(`sources.${s}`)}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <div>
                  <SubmitButton>{tc('create')}</SubmitButton>
                </div>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
