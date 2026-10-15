import { listTemplates } from '@hubium/core';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { TemplateForm } from './template-form';

export const generateMetadata = titled('competencies', 'templates');

export default async function PlanTemplatesPage() {
  const { ctx } = await requireCapability('competency:templatemanage');
  const [t, format, templates] = await Promise.all([
    getTranslations('competencies'),
    getFormatter(),
    listTemplates(ctx),
  ]);
  return (
    <>
      <PageHeader
        title={t('templates')}
        description={
          <Link href="/admin/competencies" className="hover:underline">
            ← {t('frameworks')}
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0">
          {templates.length === 0 ? (
            <EmptyState title={t('noTemplates')} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <Tr>
                    <Th>{t('name')}</Th>
                    <Th>{t('dueDate')}</Th>
                    <Th>{t('count')}</Th>
                    <Th>{t('plans')}</Th>
                  </Tr>
                </THead>
                <TBody>
                  {templates.map((x) => (
                    <Tr key={x.id}>
                      <Td>
                        <Link
                          href={`/admin/competencies/templates/${x.id}`}
                          className="hover:underline"
                        >
                          {x.name}
                        </Link>{' '}
                        {x.visible ? null : <Badge variant="neutral">{t('hidden')}</Badge>}
                      </Td>
                      <Td>
                        {x.dueDate ? format.dateTime(x.dueDate, { dateStyle: 'medium' }) : '—'}
                      </Td>
                      <Td>{x._count.competencies}</Td>
                      <Td>{x._count.plans}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </div>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>{t('newTemplate')}</CardTitle>
          </CardHeader>
          <CardContent>
            <TemplateForm />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
