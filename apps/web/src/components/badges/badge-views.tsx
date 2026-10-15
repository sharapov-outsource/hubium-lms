import {
  type BadgeCriteriaT,
  badgeDetail,
  criteriaNarrative,
  ForbiddenError,
  getAllSettings,
  listBadges,
  roleName,
} from '@hubium/core';
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
import Link from 'next/link';
import { forbidden, notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CommandButton } from '@/components/confirm-button';
import { RevokeButton } from '@/components/revoke-button';
import {
  deleteBadgeAction,
  markBadgeAction,
  revokeBadgeAwardAction,
  saveBadgeIssuerAction,
  setBadgeStatusAction,
} from '@/server/actions/badges';
import { db } from '@/server/db';
import { forbiddenOnDenied } from '@/server/forbidden';
import { getContext } from '@/server/session';
import { BadgeEditor, type BadgeEditorOptions } from './badge-editor';
import { BadgeImage } from './badge-image';

// The badge pages of a course (/course/<id>/badges) and of the site (/admin/badges):
// the same three views, with the course or null.

const baseOf = (courseId: string | null) =>
  courseId ? `/course/${courseId}/badges` : '/admin/badges';

async function StatusBadge({ status }: { status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED' }) {
  const t = await getTranslations('badges');
  const variant = status === 'ACTIVE' ? 'success' : status === 'DRAFT' ? 'warning' : 'neutral';
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>;
}

/** The badges of a course or the site: managers see all of them, others what is on offer. */
export async function BadgeList({ courseId }: { courseId: string | null }) {
  const ctx = await getContext();
  const [data, t, locale, format] = await Promise.all([
    listBadges(ctx, courseId).catch(forbiddenOnDenied),
    getTranslations('badges'),
    getLocale(),
    getFormatter(),
  ]);
  const base = baseOf(courseId);
  const narratives = await Promise.all(data.badges.map((b) => criteriaNarrative(db, b, locale)));
  return (
    <>
      <PageHeader
        title={courseId ? t('courseTitle') : t('siteTitle')}
        actions={
          data.manage ? (
            <Button asChild>
              <Link href={`${base}/new`}>{t('new')}</Link>
            </Button>
          ) : null
        }
      />
      <div className={courseId ? '' : 'grid gap-6 lg:grid-cols-[1fr_20rem]'}>
        <div className="grid content-start gap-3">
          {data.badges.length === 0 ? <EmptyState title={t('empty')} /> : null}
          {data.badges.map((b, i) => (
            <Card key={b.id}>
              <CardContent className="flex flex-wrap items-start gap-4 pt-6">
                <BadgeImage badgeId={b.id} name={b.name} size={16} />
                <div className="grid min-w-0 flex-1 gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold">
                      {data.viewAwards ? (
                        <Link href={`${base}/${b.id}`} className="hover:underline">
                          {b.name}
                        </Link>
                      ) : (
                        b.name
                      )}
                    </h2>
                    {data.manage ? <StatusBadge status={b.status} /> : null}
                    {b.mine && !b.mine.revokedAt ? (
                      <Link href={`/badge/${b.mine.id}`}>
                        <Badge variant="success">
                          {t('earnedOn', {
                            date: format.dateTime(b.mine.issuedAt, { dateStyle: 'medium' }),
                          })}
                        </Badge>
                      </Link>
                    ) : null}
                  </div>
                  {b.description ? (
                    <p className="whitespace-pre-line text-sm text-muted-foreground">
                      {b.description}
                    </p>
                  ) : null}
                  {narratives[i] ? (
                    <p className="text-sm">
                      <span className="text-muted-foreground">{t('criteria')}: </span>
                      {narratives[i]}
                    </p>
                  ) : null}
                  {data.viewAwards ? (
                    <p className="text-xs text-muted-foreground">
                      {t('awardedCount', { count: b.awarded })}
                    </p>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        {courseId ? null : <IssuerCard />}
      </div>
    </>
  );
}

async function IssuerCard() {
  const [t, tc, s] = await Promise.all([
    getTranslations('badges'),
    getTranslations('common'),
    getAllSettings(db),
  ]);
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>{t('issuerTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ActionForm action={saveBadgeIssuerAction} success={tc('saved')} className="grid gap-3">
          <FormField
            name="name"
            id="issuer-name"
            label={t('issuerName')}
            hint={t('issuerNameHint')}
            defaultValue={s['badges.issuerName']}
            placeholder={s['site.name']}
          />
          <FormField
            name="email"
            id="issuer-email"
            type="email"
            label={t('issuerEmail')}
            defaultValue={s['badges.issuerEmail']}
          />
          <div>
            <SubmitButton>{tc('save')}</SubmitButton>
          </div>
        </ActionForm>
      </CardContent>
    </Card>
  );
}

/** What the editor offers to choose from. */
async function editorOptions(courseId: string | null): Promise<BadgeEditorOptions> {
  const locale = await getLocale();
  const [activities, roles, courses, cohorts] = await Promise.all([
    courseId
      ? db.activity.findMany({
          where: { courseId, deletedAt: null },
          select: { id: true, name: true },
          orderBy: [{ section: { rank: 'asc' } }, { rank: 'asc' }],
        })
      : [],
    db.role.findMany({ orderBy: { sortOrder: 'asc' } }),
    courseId
      ? []
      : db.course.findMany({
          where: { deletedAt: null },
          select: { id: true, fullName: true },
          orderBy: { fullName: 'asc' },
        }),
    courseId
      ? []
      : db.cohort.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  return {
    activities,
    roles: roles.map((r) => ({ id: r.id, name: roleName(r, locale) })),
    courses: courses.map((c) => ({ id: c.id, name: c.fullName })),
    cohorts,
  };
}

async function canManage(courseId: string | null) {
  const ctx = await getContext();
  return courseId ? ctx.perm.can('badge:manage', courseId) : ctx.perm.can('badge:managesite');
}

export async function BadgeNew({ courseId }: { courseId: string | null }) {
  if (!(await canManage(courseId))) forbidden();
  const t = await getTranslations('badges');
  return (
    <>
      <PageHeader title={t('new')} />
      <Card className="max-w-3xl">
        <CardContent className="pt-6">
          <BadgeEditor courseId={courseId} options={await editorOptions(courseId)} locked={false} />
        </CardContent>
      </Card>
    </>
  );
}

/** A badge for those who manage or award it: its state, editor, and who has it. */
export async function BadgeView({
  courseId,
  badgeId,
}: {
  courseId: string | null;
  badgeId: string;
}) {
  if (!/^[0-9a-f-]{36}$/.test(badgeId)) notFound();
  const ctx = await getContext();
  const d = await badgeDetail(ctx, badgeId).catch((e) => {
    if (e instanceof ForbiddenError) forbidden();
    notFound();
  });
  if (d.badge.courseId !== courseId) notFound();
  const [t, tc, format, locale] = await Promise.all([
    getTranslations('badges'),
    getTranslations('common'),
    getFormatter(),
    getLocale(),
  ]);
  const b = d.badge;
  const narrative = await criteriaNarrative(db, b, locale);
  const awarded = d.awards.length > 0;
  const manual = (b.criteria as BadgeCriteriaT).rules.some((r) => r.kind === 'manual');
  const date = (x: Date) => format.dateTime(x, { dateStyle: 'medium' });
  const status = (s: 'DRAFT' | 'ACTIVE' | 'ARCHIVED') =>
    setBadgeStatusAction.bind(null, courseId, b.id, s);
  return (
    <>
      <PageHeader
        title={b.name}
        description={
          <Link href={baseOf(courseId)} className="hover:underline">
            ← {courseId ? t('courseTitle') : t('siteTitle')}
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid content-start gap-6">
          <Card>
            <CardContent className="flex flex-wrap items-start gap-4 pt-6">
              <BadgeImage badgeId={b.id} name={b.name} size={16} />
              <div className="grid min-w-0 flex-1 gap-2">
                <div>
                  <StatusBadge status={b.status} />
                </div>
                {narrative ? (
                  <p className="text-sm">
                    <span className="text-muted-foreground">{t('criteria')}: </span>
                    {narrative}
                  </p>
                ) : null}
                {b.status !== 'DRAFT' ? (
                  <p className="text-sm">
                    <Link href={`/badge/class/${b.id}`} className="text-accent hover:underline">
                      {t('publicPage')}
                    </Link>
                  </p>
                ) : null}
                {d.manage ? (
                  <div className="flex flex-wrap gap-2">
                    {b.status !== 'ACTIVE' ? (
                      <CommandButton size="sm" run={status('ACTIVE')} success={t('activated')}>
                        {b.status === 'DRAFT' ? t('activate') : t('reactivate')}
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
                    {b.status !== 'DRAFT' && !awarded ? (
                      <CommandButton size="sm" variant="secondary" run={status('DRAFT')}>
                        {t('toDraft')}
                      </CommandButton>
                    ) : null}
                    {!awarded ? (
                      <CommandButton
                        size="sm"
                        variant="destructive"
                        confirm={`${tc('delete')}: ${b.name}?`}
                        run={deleteBadgeAction.bind(null, courseId, b.id)}
                      >
                        {tc('delete')}
                      </CommandButton>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('awards')}</CardTitle>
            </CardHeader>
            <CardContent>
              {d.awards.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noAwards')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <THead>
                      <Tr>
                        <Th>{t('recipient')}</Th>
                        <Th>{t('issuedOn')}</Th>
                        <Th>{t('expires')}</Th>
                        <Th>{t('state')}</Th>
                        <Th>
                          <span className="sr-only">{tc('actions')}</span>
                        </Th>
                      </Tr>
                    </THead>
                    <TBody>
                      {d.awards.map((a) => (
                        <Tr key={a.id}>
                          <Td>
                            <Link href={`/badge/${a.id}`} className="hover:underline">
                              {a.user.name}
                            </Link>
                          </Td>
                          <Td>{date(a.issuedAt)}</Td>
                          <Td>{a.expiresAt ? date(a.expiresAt) : t('never')}</Td>
                          <Td>
                            {a.revokedAt ? (
                              <Badge variant="destructive" title={a.revokedReason ?? undefined}>
                                {t('revoked')}
                              </Badge>
                            ) : a.expiresAt && a.expiresAt < new Date() ? (
                              <Badge variant="warning">{t('expired')}</Badge>
                            ) : (
                              <Badge variant="success">{t('valid')}</Badge>
                            )}
                          </Td>
                          <Td className="text-right">
                            {d.award && !a.revokedAt ? (
                              <RevokeButton
                                action={revokeBadgeAwardAction}
                                hidden={{ awardId: a.id, ...(courseId ? { courseId } : {}) }}
                                name={a.user.name}
                                label={t('revoke')}
                                reasonLabel={t('revokeReason')}
                                done={t('revokedDone')}
                              />
                            ) : null}
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
                <BadgeEditor
                  courseId={courseId}
                  badge={{
                    id: b.id,
                    name: b.name,
                    description: b.description,
                    criteria: b.criteria as never,
                    expiresAfterDays: b.expiresAfterDays,
                    expiresAt: b.expiresAt?.toISOString() ?? null,
                  }}
                  options={await editorOptions(courseId)}
                  locked={awarded}
                />
              </CardContent>
            </Card>
          ) : null}
        </div>
        {d.award && manual && b.status === 'ACTIVE' ? (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>{t('awardByHand')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ActionForm
                action={markBadgeAction}
                success={t('marked')}
                resetOnSuccess
                className="grid gap-3"
              >
                <input type="hidden" name="badgeId" value={b.id} />
                {courseId ? <input type="hidden" name="courseId" value={courseId} /> : null}
                {courseId ? (
                  <FormField name="userId" id="mark-user" label={t('learner')}>
                    <Select id="mark-user" name="userId" required>
                      {d.awardable.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                ) : (
                  <FormField
                    name="login"
                    id="mark-login"
                    label={t('learner')}
                    placeholder="email / login"
                  />
                )}
                <p className="text-xs text-muted-foreground">{t('awardByHandHint')}</p>
                <div>
                  <SubmitButton disabled={!!courseId && !d.awardable.length}>
                    {t('award')}
                  </SubmitButton>
                </div>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
