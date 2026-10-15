import { ForbiddenError, formatCell, OPERATORS, viewReport } from '@hubium/core';
import {
  Button,
  Card,
  CardContent,
  Checkbox,
  EmptyState,
  Field,
  Input,
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
import { forbidden, notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Pagination } from '@/components/pagination';
import { titled } from '@/server/page-title';
import { readFilters } from '@/server/report-filters';
import { getContext, requireUser } from '@/server/session';

export const generateMetadata = titled('customReports', 'title');

const NO_VALUE = ['empty', 'notEmpty', 'isTrue', 'isFalse'];

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ reportId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const { reportId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(reportId)) notFound();
  const sp = await searchParams;
  const { filters, params: kept } = readFilters(sp);
  const page = Number(Array.isArray(sp.page) ? sp.page[0] : sp.page) || 1;
  const ctx = await getContext();
  const v = await viewReport(ctx, reportId, { filters, page }).catch((e) => {
    if (e instanceof ForbiddenError) forbidden();
    notFound();
  });
  const [t, tAll, tc, locale] = await Promise.all([
    getTranslations('customReports'),
    getTranslations(),
    getTranslations('common'),
    getLocale(),
  ]);
  const query = new URLSearchParams(kept).toString();
  const columns = v.columns.map((c, i) => ({ ...c, id: `${i}:${c.key}` }));
  const rows = v.rows.map((cells, i) => ({ id: (v.page - 1) * v.pageSize + i, cells }));
  const download = (format: string) =>
    `/reports/${reportId}/export?format=${format}${query ? `&${query}` : ''}`;
  return (
    <>
      <PageHeader
        title={v.report.name}
        description={
          <Link href="/reports" className="hover:underline">
            ← {t('title')}
          </Link>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary" size="sm">
              <a href={download('xlsx')}>{t('downloadXlsx')}</a>
            </Button>
            <Button asChild variant="secondary" size="sm">
              <a href={download('csv')}>{t('downloadCsv')}</a>
            </Button>
            {v.customise ? (
              <Button asChild size="sm">
                <Link href={`/reports/${reportId}/edit`}>{tc('edit')}</Link>
              </Button>
            ) : null}
          </div>
        }
      />
      {v.filters.length ? (
        <Card className="mb-4">
          <CardContent className="pt-6">
            <form method="get" className="grid gap-3">
              <div className="grid gap-3 md:grid-cols-2">
                {v.filters.map((f) => {
                  const current = filters[f.key];
                  const value = current?.value;
                  const id = `flt-${f.key.replace(/[^a-zA-Z0-9]/g, '-')}`;
                  return (
                    <fieldset
                      key={f.key}
                      className="grid gap-2 rounded-md border border-border p-2"
                    >
                      <legend className="px-1 text-sm font-medium">{f.label}</legend>
                      <div className="flex flex-wrap items-end gap-2">
                        <Field label={t('operator')} htmlFor={`${id}-op`}>
                          <Select
                            id={`${id}-op`}
                            name={`f.${f.key}.op`}
                            defaultValue={current?.op ?? ''}
                          >
                            <option value="">{t('any')}</option>
                            {OPERATORS[f.type].map((o) => (
                              <option key={o} value={o}>
                                {t(`ops.${o}`)}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        {f.type === 'enum' ? (
                          <div className="flex flex-wrap gap-x-3 gap-y-1 pb-2 text-sm">
                            {f.options.map((o) => (
                              <label
                                key={o}
                                htmlFor={`${id}-${o}`}
                                className="flex items-center gap-1.5"
                              >
                                <Checkbox
                                  id={`${id}-${o}`}
                                  name={`f.${f.key}.v`}
                                  value={o}
                                  defaultChecked={
                                    Array.isArray(value) ? value.includes(o) : value === o
                                  }
                                />
                                {t(`values.${f.key}.${o}`)}
                              </label>
                            ))}
                          </div>
                        ) : f.type === 'boolean' ? null : (
                          <Field label={t('value')} htmlFor={`${id}-v`}>
                            <Input
                              id={`${id}-v`}
                              name={`f.${f.key}.v`}
                              type={
                                f.type === 'number' ? 'number' : f.type === 'date' ? 'text' : 'text'
                              }
                              placeholder={f.type === 'date' ? t('datePlaceholder') : undefined}
                              defaultValue={
                                typeof value === 'string' && !NO_VALUE.includes(current?.op ?? '')
                                  ? value
                                  : ''
                              }
                            />
                          </Field>
                        )}
                      </div>
                    </fieldset>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <Button type="submit">{t('apply')}</Button>
                <Button asChild variant="ghost">
                  <Link href={`/reports/${reportId}`}>{t('reset')}</Link>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}
      <p className="mb-2 text-sm text-muted-foreground">{t('total', { n: v.total })}</p>
      {v.rows.length === 0 ? (
        <EmptyState title={t('noRows')} />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <Tr>
                {columns.map((c) => (
                  <Th key={c.id}>{c.label}</Th>
                ))}
              </Tr>
            </THead>
            <TBody>
              {rows.map((row) => (
                <Tr key={row.id}>
                  {columns.map((c, i) => (
                    <Td
                      key={c.id}
                      className={c.type === 'number' ? 'text-right tabular-nums' : undefined}
                    >
                      {formatCell(row.cells[i]!, c.type, c.key, locale, v.tz, (k) =>
                        tAll(k as never),
                      )}
                    </Td>
                  ))}
                </Tr>
              ))}
            </TBody>
          </Table>
        </div>
      )}
      <Pagination page={v.page} pageSize={v.pageSize} total={v.total} params={kept} />
    </>
  );
}
