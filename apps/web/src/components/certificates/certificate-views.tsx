import {
  certificateDetail,
  defaultFields,
  ForbiddenError,
  listCertificates,
  type Orientation,
  verifyUrl,
} from '@hubium/core';
import { fileUrl } from '@hubium/core/files/files';
import {
  Badge,
  Button,
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
import { FileText } from 'lucide-react';
import Link from 'next/link';
import { forbidden, notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CommandButton } from '@/components/confirm-button';
import { RevokeButton } from '@/components/revoke-button';
import {
  deleteCertificateAction,
  issueCertificateAction,
  revokeCertificateAction,
  setCertificateStatusAction,
} from '@/server/actions/certificates';
import { db } from '@/server/db';
import { forbiddenOnDenied } from '@/server/forbidden';
import { getContext, requireUser } from '@/server/session';
import { CertificateEditor, type EditorField } from './certificate-editor';

// The certificate pages of a course: the list, a new template, and one certificate with
// its editor and the people it was issued to.

const pdfHref = (issueId: string) => `/api/certificates/issues/${issueId}/pdf`;

async function StatusBadge({ status }: { status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED' }) {
  const t = await getTranslations('certificates');
  const variant = status === 'ACTIVE' ? 'success' : status === 'DRAFT' ? 'warning' : 'neutral';
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>;
}

export async function CertificateList({ courseId }: { courseId: string }) {
  const ctx = await getContext();
  const [data, t, format] = await Promise.all([
    listCertificates(ctx, courseId).catch(forbiddenOnDenied),
    getTranslations('certificates'),
    getFormatter(),
  ]);
  const base = `/course/${courseId}/certificates`;
  return (
    <>
      <PageHeader
        title={t('title')}
        actions={
          data.manage ? (
            <Button asChild>
              <Link href={`${base}/new`}>{t('new')}</Link>
            </Button>
          ) : null
        }
      />
      <div className="grid content-start gap-3">
        {data.certificates.length === 0 ? <EmptyState title={t('empty')} /> : null}
        {data.certificates.map((c) => (
          <Card key={c.id}>
            <CardContent className="flex flex-wrap items-start gap-4 pt-6">
              <FileText className="size-8 shrink-0 text-muted-foreground" aria-hidden />
              <div className="grid min-w-0 flex-1 gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">
                    {data.viewIssues ? (
                      <Link href={`${base}/${c.id}`} className="hover:underline">
                        {c.name}
                      </Link>
                    ) : (
                      c.name
                    )}
                  </h2>
                  {data.manage ? <StatusBadge status={c.status} /> : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  {c.onCompletion ? t('onCompletionNote') : t('byHandNote')}
                </p>
                {c.mine && !c.mine.revokedAt ? (
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <Badge variant="success">
                      {t('issuedOn', {
                        date: format.dateTime(c.mine.issuedAt, { dateStyle: 'medium' }),
                      })}
                    </Badge>
                    <a href={pdfHref(c.mine.id)} className="text-accent hover:underline">
                      {t('download')}
                    </a>
                  </p>
                ) : null}
                {data.viewIssues ? (
                  <p className="text-xs text-muted-foreground">
                    {t('issuedCount', { count: c.issued })}
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}

/** What the editor needs besides the certificate: default layouts and sample values. */
async function editorProps(courseId: string) {
  const [me, locale, format, course] = await Promise.all([
    requireUser(),
    getLocale(),
    getFormatter(),
    db.course.findUniqueOrThrow({ where: { id: courseId }, select: { fullName: true } }),
  ]);
  const layout = (o: Orientation) => defaultFields(o, locale) as EditorField[];
  return {
    defaults: { landscape: layout('landscape'), portrait: layout('portrait') },
    sample: {
      name: me.name,
      course: course.fullName,
      date: format.dateTime(new Date(), { dateStyle: 'long' }),
      grade: format.number(0.95, { style: 'percent' }),
      code: '0000-0000-0000',
      url: verifyUrl('0000-0000-0000'),
    },
  };
}

export async function CertificateNew({ courseId }: { courseId: string }) {
  const ctx = await getContext();
  if (!(await ctx.perm.can('certificate:manage', courseId))) forbidden();
  const t = await getTranslations('certificates');
  return (
    <>
      <PageHeader title={t('new')} />
      <Card>
        <CardContent className="pt-6">
          <CertificateEditor
            courseId={courseId}
            backgroundUrl={null}
            {...(await editorProps(courseId))}
          />
        </CardContent>
      </Card>
    </>
  );
}

export async function CertificateView({
  courseId,
  certificateId,
}: {
  courseId: string;
  certificateId: string;
}) {
  if (!/^[0-9a-f-]{36}$/.test(certificateId)) notFound();
  const ctx = await getContext();
  const d = await certificateDetail(ctx, certificateId).catch((e) => {
    if (e instanceof ForbiddenError) forbidden();
    notFound();
  });
  if (d.certificate.courseId !== courseId) notFound();
  const [t, tc, format] = await Promise.all([
    getTranslations('certificates'),
    getTranslations('common'),
    getFormatter(),
  ]);
  const c = d.certificate;
  const issued = d.issues.length > 0;
  const date = (x: Date) => format.dateTime(x, { dateStyle: 'medium' });
  const status = (s: 'DRAFT' | 'ACTIVE' | 'ARCHIVED') =>
    setCertificateStatusAction.bind(null, courseId, c.id, s);
  const background = c.backgroundFileId
    ? await db.file.findUnique({
        where: { id: c.backgroundFileId },
        select: { id: true, name: true },
      })
    : null;
  return (
    <>
      <PageHeader
        title={c.name}
        description={
          <Link href={`/course/${courseId}/certificates`} className="hover:underline">
            ← {t('title')}
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardContent className="flex flex-wrap items-center gap-3 pt-6">
              <StatusBadge status={c.status} />
              <span className="text-sm text-muted-foreground">
                {c.onCompletion ? t('onCompletionNote') : t('byHandNote')}
              </span>
              {d.manage ? (
                <div className="flex w-full flex-wrap gap-2">
                  <Button asChild size="sm" variant="secondary">
                    <a href={`/api/certificates/${c.id}/preview`} target="_blank" rel="noreferrer">
                      {t('previewPdf')}
                    </a>
                  </Button>
                  {c.status !== 'ACTIVE' ? (
                    <CommandButton size="sm" run={status('ACTIVE')} success={t('activated')}>
                      {c.status === 'DRAFT' ? t('activate') : t('reactivate')}
                    </CommandButton>
                  ) : (
                    <CommandButton
                      size="sm"
                      variant="secondary"
                      confirm={t('archiveConfirm')}
                      run={status('ARCHIVED')}
                    >
                      {t('archive')}
                    </CommandButton>
                  )}
                  {c.status !== 'DRAFT' && !issued ? (
                    <CommandButton size="sm" variant="secondary" run={status('DRAFT')}>
                      {t('toDraft')}
                    </CommandButton>
                  ) : null}
                  {!issued ? (
                    <CommandButton
                      size="sm"
                      variant="destructive"
                      confirm={`${tc('delete')}: ${c.name}?`}
                      run={deleteCertificateAction.bind(null, courseId, c.id)}
                    >
                      {tc('delete')}
                    </CommandButton>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle>{t('issues')}</CardTitle>
              {issued ? (
                <Button asChild size="sm" variant="ghost">
                  <a href={`/api/certificates/${c.id}/issues`}>{t('exportCsv')}</a>
                </Button>
              ) : null}
            </CardHeader>
            <CardContent>
              {d.issues.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noIssues')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <THead>
                      <Tr>
                        <Th>{t('recipient')}</Th>
                        <Th>{t('code')}</Th>
                        <Th>{t('issued')}</Th>
                        <Th>{t('state')}</Th>
                        <Th>
                          <span className="sr-only">{tc('actions')}</span>
                        </Th>
                      </Tr>
                    </THead>
                    <TBody>
                      {d.issues.map((i) => (
                        <Tr key={i.id}>
                          <Td>{i.user.name}</Td>
                          <Td className="font-mono text-xs">
                            <Link href={`/verify/${i.code}`} className="hover:underline">
                              {i.code}
                            </Link>
                          </Td>
                          <Td>{date(i.issuedAt)}</Td>
                          <Td>
                            {i.revokedAt ? (
                              <Badge variant="destructive" title={i.revokedReason ?? undefined}>
                                {t('revoked')}
                              </Badge>
                            ) : (
                              <Badge variant="success">{t('valid')}</Badge>
                            )}
                          </Td>
                          <Td className="whitespace-nowrap text-right">
                            {i.revokedAt ? null : (
                              <>
                                <Button asChild size="sm" variant="ghost">
                                  <a
                                    href={pdfHref(i.id)}
                                    aria-label={`${t('download')}: ${i.user.name}`}
                                  >
                                    PDF
                                  </a>
                                </Button>
                                {d.issue ? (
                                  <RevokeButton
                                    action={revokeCertificateAction}
                                    hidden={{ issueId: i.id, courseId }}
                                    name={i.user.name}
                                    label={t('revoke')}
                                    reasonLabel={t('revokeReason')}
                                    done={t('revokedDone')}
                                  />
                                ) : null}
                              </>
                            )}
                          </Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
          {d.manage ? (
            <Card>
              <CardHeader>
                <CardTitle>{tc('edit')}</CardTitle>
              </CardHeader>
              <CardContent>
                <CertificateEditor
                  courseId={courseId}
                  certificate={{
                    id: c.id,
                    name: c.name,
                    orientation: c.orientation === 'portrait' ? 'portrait' : 'landscape',
                    fields: c.fields as EditorField[],
                    onCompletion: c.onCompletion,
                  }}
                  backgroundUrl={background ? fileUrl(background) : null}
                  {...(await editorProps(courseId))}
                />
              </CardContent>
            </Card>
          ) : null}
        </div>
        {d.issue && c.status === 'ACTIVE' ? (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>{t('issueByHand')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ActionForm
                action={issueCertificateAction}
                success={t('issuedDone')}
                resetOnSuccess
                className="grid gap-3"
              >
                <input type="hidden" name="certificateId" value={c.id} />
                <input type="hidden" name="courseId" value={courseId} />
                <FormField name="userId" id="issue-user" label={t('learner')}>
                  <Select id="issue-user" name="userId" required>
                    {d.issuable.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <p className="text-xs text-muted-foreground">{t('issueByHandHint')}</p>
                <div>
                  <SubmitButton disabled={!d.issuable.length}>{t('issue')}</SubmitButton>
                </div>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
