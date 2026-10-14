import { ForbiddenError, menteeOverview, NotFoundError } from '@hubium/core';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Progress,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { forbidden, notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { cache } from 'react';
import { getContext, requireUser } from '@/server/session';

const UUID = /^[0-9a-f-]{36}$/;

const overview = cache(async (userId: string) => {
  await requireUser();
  if (!UUID.test(userId)) notFound();
  try {
    return await menteeOverview(await getContext(), userId);
  } catch (e) {
    if (e instanceof ForbiddenError) forbidden();
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
});

export async function generateMetadata({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const o = await overview(userId);
  return { title: o.user.name };
}

export default async function MenteePage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const [o, t, tc, format] = await Promise.all([
    overview(userId),
    getTranslations('mentees'),
    getTranslations('course'),
    getFormatter(),
  ]);
  const fmt = (v: number) => String(Math.round(v * 100) / 100);
  return (
    <>
      <Link
        href="/mentees"
        className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t('title')}
      </Link>
      <PageHeader
        title={o.user.name}
        description={
          o.user.lastAccessAt
            ? t('lastVisit', { time: format.relativeTime(o.user.lastAccessAt) })
            : t('neverVisited')
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{t('courses')}</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {o.courses.length ? (
              <Table>
                <THead>
                  <Tr>
                    <Th>{t('course')}</Th>
                    <Th>{t('progress')}</Th>
                    <Th>{t('total')}</Th>
                    <Th className="hidden md:table-cell">{t('lastCourseVisit')}</Th>
                  </Tr>
                </THead>
                <TBody>
                  {o.courses.map((c) => (
                    <Tr key={c.id}>
                      <Td>
                        <Link
                          href={`/mentees/${o.user.id}/courses/${c.id}`}
                          className="font-medium hover:underline"
                        >
                          {c.fullName}
                        </Link>
                      </Td>
                      <Td className="sm:min-w-32">
                        {c.progress === null ? (
                          '—'
                        ) : (
                          <span className="flex items-center gap-2">
                            <Progress
                              value={c.progress}
                              label={tc('progress', { percent: c.progress })}
                              className="hidden w-20 sm:block"
                            />
                            <span className="tabular-nums text-sm">{c.progress}%</span>
                          </span>
                        )}
                      </Td>
                      <Td className="tabular-nums">
                        {c.grade ? `${fmt(c.grade.value)} / ${fmt(c.grade.max)}` : '—'}
                      </Td>
                      <Td className="hidden text-sm text-muted-foreground md:table-cell">
                        {c.lastAccessAt ? format.relativeTime(c.lastAccessAt) : '—'}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            ) : (
              <EmptyState title={t('noCourses')} />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('deadlines')}</CardTitle>
          </CardHeader>
          <CardContent>
            {o.todo.length ? (
              <ul className="grid gap-3 text-sm">
                {o.todo.map((i) => (
                  <li key={`${i.activityId}-${i.kind}`} className="grid gap-0.5">
                    <span className="font-medium">{i.title}</span>
                    <span className="text-muted-foreground">
                      {t(i.kind === 'attempt' ? 'toAttempt' : 'toSubmit')}
                      {i.dueAt
                        ? ` · ${format.dateTime(i.dueAt, { dateStyle: 'medium', timeStyle: 'short' })}`
                        : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('noDeadlines')}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
