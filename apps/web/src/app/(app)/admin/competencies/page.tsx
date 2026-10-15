import { listFrameworks } from '@hubium/core';
import {
  Badge,
  Button,
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
import { forbidden } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { importFrameworkAction } from '@/server/actions/competencies';
import { titled } from '@/server/page-title';
import { getContext, requireUser } from '@/server/session';

export const generateMetadata = titled('competencies', 'frameworks');

export default async function CompetencyFrameworksPage() {
  await requireUser();
  const ctx = await getContext();
  const [manage, templates] = await Promise.all([
    ctx.perm.can('competency:manage'),
    ctx.perm.can('competency:templatemanage'),
  ]);
  if (!manage && !templates) forbidden();
  const [t, frameworks] = await Promise.all([
    getTranslations('competencies'),
    manage ? listFrameworks(ctx) : [],
  ]);
  return (
    <>
      <PageHeader
        title={t('frameworks')}
        description={t('frameworksIntro')}
        actions={
          <div className="flex flex-wrap gap-2">
            {templates ? (
              <Button asChild variant="secondary">
                <Link href="/admin/competencies/templates">{t('templates')}</Link>
              </Button>
            ) : null}
            {manage ? (
              <Button asChild>
                <Link href="/admin/competencies/new">{t('newFramework')}</Link>
              </Button>
            ) : null}
          </div>
        }
      />
      {manage ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="min-w-0">
            {frameworks.length === 0 ? (
              <EmptyState title={t('noFrameworks')} />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <Tr>
                      <Th>{t('name')}</Th>
                      <Th>{t('idNumber')}</Th>
                      <Th>{t('scale')}</Th>
                      <Th>{t('count')}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {frameworks.map((f) => (
                      <Tr key={f.id}>
                        <Td>
                          <Link href={`/admin/competencies/${f.id}`} className="hover:underline">
                            {f.shortName}
                          </Link>{' '}
                          {f.visible ? null : <Badge variant="neutral">{t('hidden')}</Badge>}
                        </Td>
                        <Td className="font-mono text-xs">{f.idNumber}</Td>
                        <Td>{f.scale.name}</Td>
                        <Td>{f._count.competencies}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </div>
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>{t('importTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ActionForm
                action={importFrameworkAction}
                success={t('imported')}
                resetOnSuccess
                className="grid gap-3"
              >
                <FormField
                  name="file"
                  id="import-file"
                  type="file"
                  accept=".csv,text/csv"
                  label={t('importFile')}
                  hint={t('importHint')}
                />
                <div>
                  <SubmitButton>{t('doImport')}</SubmitButton>
                </div>
              </ActionForm>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </>
  );
}
