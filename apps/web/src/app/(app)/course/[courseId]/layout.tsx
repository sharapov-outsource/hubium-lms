import {
  aiFeaturesFor,
  categoryPath,
  courseAutoLinks,
  getCourseAccess,
  roleName,
} from '@hubium/core';
import { Alert, Badge } from '@hubium/ui';
import { LogOut } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { AutoLinks } from '@/components/auto-links';
import { CommandButton } from '@/components/confirm-button';
import { leaveCourseAction } from '@/server/actions/courses';
import { db } from '@/server/db';
import { courseName, sectionTitle } from '@/server/page-title';
import { getContext, getSwitchedRole, requireUser } from '@/server/session';
import { CourseTabs } from './course-tabs';
import { GuestNotice } from './self-enrol';
import { ViewAsMenu } from './view-as';

export async function generateMetadata({ params }: { params: Promise<{ courseId: string }> }) {
  const name = await courseName((await params).courseId);
  return name ? sectionTitle(name) : {};
}

export default async function CourseLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ courseId: string }>;
}) {
  await requireUser();
  const { courseId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(courseId)) notFound();
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId).catch(() => null);
  if (!access || (access.course.deletedAt && !ctx.perm.isSiteAdmin)) notFound();
  // a hidden course does not exist for those who may not see hidden courses: no name,
  // description or enrolment form
  if (!access.course.visible && !access.canViewHidden) notFound();
  const [t, tn, tcat, locale, path, switched] = await Promise.all([
    getTranslations('course'),
    getTranslations('nav'),
    getTranslations('catalog'),
    getLocale(),
    categoryPath(db, access.course.categoryId),
    getSwitchedRole(),
  ]);
  const realCtxCanSwitch = await ctx.perm.can('course:switchrole', courseId);
  const viewingAs =
    switched?.contextId === courseId
      ? await db.role.findUnique({ where: { id: switched.roleId } })
      : null;
  const switchable =
    viewingAs || realCtxCanSwitch
      ? await db.role.findMany({
          where: { shortName: { in: ['student', 'teacher', 'observer', 'guest'] } },
          orderBy: { sortOrder: 'asc' },
        })
      : [];
  const roleLabel = (r: { name: unknown; shortName: string }) => roleName(r, locale);
  const base = `/course/${courseId}`;
  const ai = access.canView ? await aiFeaturesFor(ctx, courseId) : null;
  const links = access.canView ? await courseAutoLinks(ctx, courseId) : [];
  const tabs = access.canView
    ? [
        { key: 'course', href: base, label: t('tabs.course'), show: true },
        { key: 'stream', href: `${base}/stream`, label: t('tabs.stream'), show: true },
        { key: 'tutor', href: `${base}/tutor`, label: t('tabs.tutor'), show: !!ai?.TUTOR },
        {
          key: 'participants',
          href: `${base}/participants`,
          label: t('tabs.participants'),
          show: access.canViewParticipants && !access.isGuest,
        },
        {
          key: 'groups',
          href: `${base}/groups`,
          label: t('tabs.groups'),
          show: access.canManageGroups,
        },
        {
          key: 'grades',
          href: `${base}/grades`,
          label: t('tabs.grades'),
          show: access.isEnrolled || access.canViewAllGrades,
        },
        {
          key: 'completion',
          href: `${base}/completion`,
          label: t('tabs.completion'),
          show:
            access.course.enableCompletion &&
            (await ctx.perm.can('completion:viewreports', courseId)),
        },
        {
          key: 'badges',
          href: `${base}/badges`,
          label: t('tabs.badges'),
          show:
            !access.isGuest &&
            ((await ctx.perm.can('badge:manage', courseId)) ||
              (await db.badge.count({
                where: {
                  courseId,
                  OR: [
                    { status: 'ACTIVE' },
                    { status: 'ARCHIVED', awards: { some: { userId: ctx.perm.userId ?? '' } } },
                  ],
                },
              })) > 0),
        },
        {
          key: 'competencies',
          href: `${base}/competencies`,
          label: t('tabs.competencies'),
          show:
            !access.isGuest &&
            ((await ctx.perm.can('competency:coursemanage', courseId)) ||
              (await db.courseCompetency.count({ where: { courseId } })) > 0),
        },
        {
          key: 'certificates',
          href: `${base}/certificates`,
          label: t('tabs.certificates'),
          show:
            !access.isGuest &&
            ((await ctx.perm.can('certificate:manage', courseId)) ||
              (await db.certificate.count({
                where: {
                  courseId,
                  OR: [
                    { status: 'ACTIVE' },
                    { status: 'ARCHIVED', issues: { some: { userId: ctx.perm.userId ?? '' } } },
                  ],
                },
              })) > 0),
        },
        {
          key: 'reports',
          href: `${base}/reports`,
          label: t('tabs.reports'),
          show: access.canViewReports,
        },
        {
          key: 'enrolment',
          href: `${base}/enrolment`,
          label: t('tabs.enrolment'),
          show: access.canManageEnrolments,
        },
        {
          key: 'permissions',
          href: `${base}/permissions`,
          label: t('tabs.permissions'),
          show: !access.isGuest && (await ctx.perm.can('role:review', courseId)),
        },
        {
          key: 'settings',
          href: `${base}/settings`,
          label: t('tabs.settings'),
          show: access.canEdit,
        },
      ].filter((x) => x.show)
    : [];
  // who enrolled themselves may leave, as the catalog let them in
  const selfEnrolled =
    !viewingAs &&
    !!ctx.perm.userId &&
    !!(await db.enrolment.findFirst({
      where: { courseId, userId: ctx.perm.userId, method: { type: 'SELF' } },
      select: { id: true },
    }));
  return (
    <div>
      {viewingAs ? (
        <Alert variant="warning" className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <span>{t('viewingAs', { role: roleLabel(viewingAs) })}</span>
          <ViewAsMenu courseId={courseId} roles={[]} active label={t('stopViewAs')} />
        </Alert>
      ) : null}
      {access.isGuest && access.canView && !viewingAs ? <GuestNotice courseId={courseId} /> : null}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <nav aria-label={tn('breadcrumb')} className="mb-1 text-xs text-muted-foreground">
            {path.map((c, i) => (
              <span key={c.id}>
                {i > 0 ? ' / ' : ''}
                {c.name}
              </span>
            ))}
          </nav>
          <h1 className="text-2xl font-semibold tracking-tight">
            {access.course.fullName}{' '}
            {!access.course.visible ? (
              <Badge variant="warning" className="align-middle">
                {t('hiddenCourse')}
              </Badge>
            ) : null}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {!viewingAs && switchable.length ? (
            <ViewAsMenu
              courseId={courseId}
              roles={switchable.map((r) => ({ id: r.id, name: roleLabel(r) }))}
              label={t('viewAs')}
            />
          ) : null}
          {selfEnrolled ? (
            <CommandButton
              variant="outline"
              size="sm"
              confirm={tcat('leaveConfirm')}
              run={leaveCourseAction.bind(null, courseId)}
            >
              <LogOut aria-hidden />
              {tcat('leave')}
            </CommandButton>
          ) : null}
        </div>
      </div>
      {tabs.length > 1 ? (
        <CourseTabs items={tabs} base={base} label={access.course.fullName} />
      ) : null}
      <AutoLinks links={links}>{children}</AutoLinks>
    </div>
  );
}
