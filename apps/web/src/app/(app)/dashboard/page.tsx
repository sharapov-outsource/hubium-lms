import {
  listMyCourses,
  listSiteAnnouncements,
  listUserEvents,
  recentCourseAnnouncements,
  upcomingRange,
} from '@hubium/core';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Progress,
} from '@hubium/ui';
import { ArrowRight, BookOpen, CalendarDays } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AnnouncementList } from '@/components/comms/announcement-list';
import { CourseCard } from '@/components/course-card';
import { db } from '@/server/db';
import { requireUser } from '@/server/session';
import { getTodo } from './todo';

export async function generateMetadata() {
  const t = await getTranslations('nav');
  return { title: t('dashboard') };
}

export default async function DashboardPage() {
  const user = await requireUser();
  const [t, tc, tcal, ta, format] = await Promise.all([
    getTranslations('dashboard'),
    getTranslations('course'),
    getTranslations('calendar'),
    getTranslations('announcements'),
    getFormatter(),
  ]);
  const [courses, events, todo] = await Promise.all([
    listMyCourses(db, user.id),
    listUserEvents(db, user.id, upcomingRange(14)),
    getTodo(user.id),
  ]);
  const [siteNews, courseNews] = await Promise.all([
    listSiteAnnouncements(db, new Date(), 3),
    recentCourseAnnouncements(
      db,
      user.id,
      courses.map((c) => c.id),
    ),
  ]);
  const last = courses.find((c) => c.lastAccessAt);
  const lastActivity = last
    ? await db.courseAccess.findUnique({
        where: { userId_courseId: { userId: user.id, courseId: last.id } },
      })
    : null;
  return (
    <>
      <PageHeader title={t('title', { name: user.firstName || user.name })} />
      {user.isSiteAdmin && courses.length === 0 ? (
        <Alert className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <span>{t('adminHint')}</span>
          <Button asChild size="sm">
            <Link href="/admin">{t('toAdmin')}</Link>
          </Button>
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-6">
          {siteNews.length ? (
            <section aria-label={ta('site')}>
              <AnnouncementList items={siteNews} canManage={false} compact />
            </section>
          ) : null}
          {last ? (
            <Card className="border-accent/30 bg-accent-soft/40">
              <CardContent className="flex flex-wrap items-center gap-4 pt-5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-muted-foreground">{t('continue')}</p>
                  <p className="truncate text-lg font-semibold">{last.fullName}</p>
                  {last.progress !== null ? (
                    <Progress
                      value={last.progress}
                      label={tc('progress', { percent: last.progress })}
                      className="mt-2 max-w-sm"
                    />
                  ) : null}
                </div>
                <Button asChild>
                  <Link
                    href={
                      lastActivity?.lastActivityId
                        ? `/course/${last.id}/a/${lastActivity.lastActivityId}`
                        : `/course/${last.id}`
                    }
                  >
                    {t('continue')}
                    <ArrowRight />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : null}
          <section aria-labelledby="my-courses-h">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="my-courses-h" className="text-lg font-semibold">
                {t('myCourses')}
              </h2>
              {courses.length > 6 ? (
                <Link href="/my-courses" className="text-sm text-accent hover:underline">
                  {t('allCourses')}
                </Link>
              ) : null}
            </div>
            {courses.length === 0 ? (
              <EmptyState
                icon={<BookOpen />}
                title={t('noCourses')}
                action={
                  <Button asChild variant="secondary">
                    <Link href="/catalog">{t('toCatalog')}</Link>
                  </Button>
                }
              />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {courses.slice(0, 6).map((c) => (
                  <CourseCard key={c.id} course={c} />
                ))}
              </div>
            )}
          </section>
          {courseNews.length ? (
            <section aria-labelledby="news-h">
              <h2 id="news-h" className="mb-3 text-lg font-semibold">
                {ta('recent')}
              </h2>
              <AnnouncementList items={courseNews} canManage={false} compact />
            </section>
          ) : null}
        </div>
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('todo')}</CardTitle>
            </CardHeader>
            <CardContent>
              {todo.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noTodo')}</p>
              ) : (
                <ul className="grid gap-3">
                  {todo.map((i) => (
                    <li key={`${i.activityId}-${i.kind}`} className="text-sm">
                      <Link
                        href={`/course/${i.courseId}/a/${i.activityId}`}
                        className="font-medium hover:underline"
                      >
                        {i.title}
                      </Link>
                      {i.dueAt ? (
                        <p className="text-xs text-muted-foreground">
                          {format.dateTime(i.dueAt, { dateStyle: 'medium', timeStyle: 'short' })}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('upcoming')}</CardTitle>
            </CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noUpcoming')}</p>
              ) : (
                <ul className="grid gap-3">
                  {events.slice(0, 8).map((e) => (
                    <li key={e.id} className="flex gap-3 text-sm">
                      <CalendarDays
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <div className="min-w-0">
                        {e.activityId && e.courseId ? (
                          <Link
                            href={`/course/${e.courseId}/a/${e.activityId}`}
                            className="font-medium hover:underline"
                          >
                            {e.title}
                          </Link>
                        ) : (
                          <span className="font-medium">{e.title}</span>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {tcal(`kinds.${e.kind}`)} ·{' '}
                          {format.dateTime(e.startsAt, {
                            dateStyle: 'medium',
                            timeStyle: e.allDay ? undefined : 'short',
                          })}
                          {e.courseName ? ` · ${e.courseName}` : ''}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
