import { listSubscriptions, listUserEvents } from '@hubium/core';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getLocale, getTimeZone, getTranslations } from 'next-intl/server';
import { CommandButton } from '@/components/confirm-button';
import {
  deleteEventAction,
  refreshSubscriptionAction,
  unsubscribeCalendarAction,
} from '@/server/actions/calendar';
import { db } from '@/server/db';
import { getContext, requireUser } from '@/server/session';
import { FeedLink, ImportCalendarForm, NewEventForm } from './calendar-parts';

function monthStart(y: number, m: number) {
  return new Date(Date.UTC(y, m, 1));
}

export async function generateMetadata() {
  return { title: (await getTranslations('calendar'))('title') };
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; w?: string; d?: string; date?: string; view?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const [t, format, locale, timeZone] = await Promise.all([
    getTranslations('calendar'),
    getFormatter(),
    getLocale(),
    getTimeZone(),
  ]);
  // Grid cells are calendar dates (UTC midnights); events are placed by their date in
  // the user's time zone, so an event at 01:00 Moscow time is not shown the day before.
  const localDay = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  // an all-day event is a date (stored as its UTC midnight), the same everywhere
  const dayOf = (e: { startsAt: Date; allDay: boolean }) =>
    e.allDay ? e.startsAt.toISOString().slice(0, 10) : localDay(e.startsAt);
  const now = new Date();
  const [ty, tm] = localDay(now).split('-').map(Number);
  const [y, m] = /^\d{4}-\d{2}$/.test(sp.m ?? '') ? sp.m!.split('-').map(Number) : [ty, tm];
  const start = monthStart(y!, m! - 1);
  const end = monthStart(y!, m!);
  const isDate = (v?: string) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');
  // ?date= (links from reminders) opens that day
  const view = isDate(sp.date)
    ? 'day'
    : sp.view === 'agenda' || sp.view === 'week' || sp.view === 'day'
      ? sp.view
      : 'month';
  const dayIso = isDate(sp.date) ? sp.date! : isDate(sp.d) ? sp.d! : null;
  // week view: the Monday (a calendar date) of the week that contains ?w= or today
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(sp.w ?? '') ? sp.w! : localDay(now);
  const anchorDate = new Date(`${anchor}T00:00:00Z`);
  const monday = new Date(anchorDate.getTime() - ((anchorDate.getUTCDay() + 6) % 7) * 86_400_000);
  const weekDays = Array.from({ length: 7 }, (_, i) => new Date(monday.getTime() + i * 86_400_000));
  const dayDate = new Date(`${dayIso ?? localDay(now)}T00:00:00Z`);
  const [from, to] =
    view === 'agenda'
      ? [now, new Date(now.getTime() + 60 * 86_400_000)]
      : view === 'day'
        ? [new Date(dayDate.getTime() - 86_400_000), new Date(dayDate.getTime() + 2 * 86_400_000)]
        : view === 'week'
          ? [new Date(monday.getTime() - 86_400_000), new Date(monday.getTime() + 8 * 86_400_000)]
          : // a day of margin on both sides covers every time zone
            [new Date(start.getTime() - 86_400_000), new Date(end.getTime() + 86_400_000)];
  const events = await listUserEvents(db, user.id, { from, to });
  const prev = new Date(Date.UTC(y!, m! - 2, 1));
  const next = new Date(Date.UTC(y!, m!, 1));
  const key = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  // Monday-first grid
  const firstDow = (start.getUTCDay() + 6) % 7;
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  const cells = Array.from({ length: Math.ceil((firstDow + days) / 7) * 7 }, (_, i) => {
    const day = i - firstDow + 1;
    return day >= 1 && day <= days ? new Date(Date.UTC(y!, m! - 1, day)) : null;
  });
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2024, 0, 1 + i)),
    ),
  );
  const ctx = await getContext();
  const courses = await db.course.findMany({
    where: { deletedAt: null, enrolments: { some: { userId: user.id } } },
    select: { id: true, fullName: true },
  });
  const manageable = [];
  for (const c of courses)
    if (await ctx.perm.can('calendar:managecourse', c.id)) manageable.push(c);
  const canSite = await ctx.perm.can('calendar:managesite');
  const subscriptions = await listSubscriptions(
    ctx,
    courses.map((c) => c.id),
  );
  const cellDay = (d: Date) => d.toISOString().slice(0, 10);
  const today = localDay(now);
  const listed = view === 'month' ? events.filter((e) => dayOf(e).startsWith(key(start))) : events;
  return (
    <>
      <PageHeader
        title={t('title')}
        actions={
          <div className="flex gap-1">
            <Button asChild size="sm" variant={view === 'day' ? 'secondary' : 'ghost'}>
              <Link href="/calendar?view=day">{t('day')}</Link>
            </Button>
            <Button asChild size="sm" variant={view === 'month' ? 'secondary' : 'ghost'}>
              <Link href="/calendar">{t('month')}</Link>
            </Button>
            <Button asChild size="sm" variant={view === 'week' ? 'secondary' : 'ghost'}>
              <Link href="/calendar?view=week">{t('week')}</Link>
            </Button>
            <Button asChild size="sm" variant={view === 'agenda' ? 'secondary' : 'ghost'}>
              <Link href="/calendar?view=agenda">{t('agenda')}</Link>
            </Button>
          </div>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div>
          {view === 'month' ? (
            <>
              <div className="mb-3 flex items-center gap-2">
                <Button asChild size="icon" variant="ghost" aria-label={t('prev')}>
                  <Link href={`/calendar?m=${key(prev)}`}>
                    <ChevronLeft />
                  </Link>
                </Button>
                <h2 className="min-w-44 text-center text-lg font-semibold capitalize">
                  {new Intl.DateTimeFormat(locale, {
                    month: 'long',
                    year: 'numeric',
                    timeZone: 'UTC',
                  }).format(start)}
                </h2>
                <Button asChild size="icon" variant="ghost" aria-label={t('next')}>
                  <Link href={`/calendar?m=${key(next)}`}>
                    <ChevronRight />
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/calendar">{t('today')}</Link>
                </Button>
              </div>
              <table className="hidden w-full table-fixed border-collapse md:table">
                <thead>
                  <tr>
                    {weekdays.map((w) => (
                      <th
                        key={w}
                        scope="col"
                        className="border border-border bg-surface px-2 py-1 text-left text-xs font-medium text-muted-foreground"
                      >
                        {w}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: cells.length / 7 }, (_, w) =>
                    cells.slice(w * 7, w * 7 + 7),
                  ).map((week, w) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed grid position
                    <tr key={w}>
                      {week.map((d, i) => (
                        <td
                          // biome-ignore lint/suspicious/noArrayIndexKey: fixed grid position
                          key={i}
                          className={cn(
                            'h-24 border border-border bg-card p-1.5 align-top text-xs',
                            !d && 'bg-surface',
                          )}
                        >
                          {d ? (
                            <>
                              <Link
                                href={`/calendar?view=day&d=${cellDay(d)}`}
                                aria-label={new Intl.DateTimeFormat(locale, {
                                  dateStyle: 'long',
                                  timeZone: 'UTC',
                                }).format(d)}
                                className={cn(
                                  'inline-flex size-6 items-center justify-center rounded-full hover:bg-muted',
                                  cellDay(d) === today &&
                                    'bg-accent text-accent-foreground hover:bg-accent',
                                )}
                              >
                                {d.getUTCDate()}
                              </Link>
                              <ul className="mt-1 grid gap-1">
                                {events
                                  .filter((e) => dayOf(e) === cellDay(d))
                                  .map((e) => (
                                    <li
                                      key={e.id}
                                      className="truncate rounded bg-accent-soft px-1 py-0.5 text-accent"
                                      title={e.title}
                                    >
                                      {e.activityId && e.courseId ? (
                                        <Link href={`/course/${e.courseId}/a/${e.activityId}`}>
                                          {e.title}
                                        </Link>
                                      ) : (
                                        e.title
                                      )}
                                    </li>
                                  ))}
                              </ul>
                            </>
                          ) : null}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          {view === 'day' ? (
            <DayView
              day={dayDate}
              events={events}
              localDay={localDay}
              today={today}
              locale={locale}
              timeZone={timeZone}
              labels={{
                prev: t('prevDay'),
                next: t('nextDay'),
                today: t('today'),
                allDay: t('allDay'),
                none: t('noEvents'),
                kinds: Object.fromEntries(
                  (
                    ['OPEN', 'CLOSE', 'DUE', 'CUTOFF', 'SESSION', 'CUSTOM', 'EXPECTED'] as const
                  ).map((k) => [k, t(`kinds.${k}`)]),
                ),
              }}
            />
          ) : null}
          {view === 'week' ? (
            <WeekView
              days={weekDays}
              events={events}
              localDay={localDay}
              today={today}
              locale={locale}
              timeZone={timeZone}
              labels={{
                prev: t('prevWeek'),
                next: t('nextWeek'),
                today: t('today'),
                allDay: t('allDay'),
                none: t('noEvents'),
              }}
            />
          ) : null}
          {/* the list: the agenda, and the month on phones */}
          {view === 'month' || view === 'agenda' ? (
            <ul className={cn('grid gap-2', view === 'month' && 'mt-4 md:hidden')}>
              {listed.length === 0 ? (
                <li className="text-sm text-muted-foreground">{t('noEvents')}</li>
              ) : null}
              {listed.map((e) => (
                <li key={e.id}>
                  <Card>
                    <CardContent className="flex items-start justify-between gap-3 pt-4">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {e.activityId && e.courseId ? (
                            <Link
                              href={`/course/${e.courseId}/a/${e.activityId}`}
                              className="hover:underline"
                            >
                              {e.title}
                            </Link>
                          ) : (
                            e.title
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {format.dateTime(
                            e.startsAt,
                            e.allDay
                              ? { dateStyle: 'full', timeZone: 'UTC' }
                              : { dateStyle: 'full', timeStyle: 'short' },
                          )}
                          {e.courseName ? ` · ${e.courseName}` : ''}
                          {e.location ? ` · ${e.location}` : ''}
                        </p>
                        {e.description ? <p className="mt-1 text-sm">{e.description}</p> : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge>{t(`kinds.${e.kind}`)}</Badge>
                        {!e.activityId && !e.subscriptionId && (e.userId === user.id || canSite) ? (
                          <CommandButton
                            size="sm"
                            variant="ghost"
                            confirm={t('deleteConfirm')}
                            run={deleteEventAction.bind(null, e.id)}
                          >
                            ×
                          </CommandButton>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('newEvent')}</CardTitle>
            </CardHeader>
            <CardContent>
              <NewEventForm courses={manageable} canSite={canSite} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('imports')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {subscriptions.length ? (
                <ul className="grid gap-3" aria-label={t('imports')}>
                  {subscriptions.map((s) => (
                    <li
                      key={s.id}
                      className="grid gap-1 rounded-md border border-border p-2 text-sm"
                    >
                      <span className="font-medium break-words">{s.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {s.scope === 'COURSE' && s.course
                          ? s.course.fullName
                          : t(`scopes.${s.scope as 'USER' | 'SITE'}`)}{' '}
                        · {s.url ? new URL(s.url).host : t('fromFile')} ·{' '}
                        {t('eventsCount', { n: s._count.events })}
                        {s.lastSyncAt
                          ? ` · ${t('lastSync', { when: format.relativeTime(s.lastSyncAt) })}`
                          : ''}
                      </span>
                      {s.lastError ? (
                        <span className="text-xs text-destructive">
                          {t('syncError', { error: s.lastError })}
                        </span>
                      ) : null}
                      <span className="flex gap-1">
                        {s.url ? (
                          <CommandButton
                            size="sm"
                            variant="outline"
                            run={refreshSubscriptionAction.bind(null, s.id)}
                            success={t('refreshed')}
                          >
                            {t('refresh')}
                          </CommandButton>
                        ) : null}
                        <CommandButton
                          size="sm"
                          variant="ghost"
                          confirm={t('unsubscribeConfirm')}
                          run={unsubscribeCalendarAction.bind(null, s.id)}
                        >
                          {t('unsubscribe')}
                        </CommandButton>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('noSubscriptions')}</p>
              )}
              <ImportCalendarForm courses={manageable} canSite={canSite} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('feed')}</CardTitle>
            </CardHeader>
            <CardContent>
              <FeedLink baseUrl={process.env.APP_URL ?? ''} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

type CalendarEvent = Awaited<ReturnType<typeof listUserEvents>>[number];

/** Seven days from Monday: columns on wide screens, a list of days on phones. */
function WeekView({
  days,
  events,
  localDay,
  today,
  locale,
  timeZone,
  labels,
}: {
  days: Date[];
  events: CalendarEvent[];
  localDay: (d: Date) => string;
  today: string;
  locale: string;
  timeZone: string;
  labels: { prev: string; next: string; today: string; allDay: string; none: string };
}) {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const shift = (n: number) => iso(new Date(days[0]!.getTime() + n * 86_400_000));
  const range = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).formatRange(days[0]!, days[6]!);
  const dayName = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone });
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="icon" variant="ghost" aria-label={labels.prev}>
          <Link href={`/calendar?view=week&w=${shift(-7)}`}>
            <ChevronLeft />
          </Link>
        </Button>
        <h2 className="min-w-44 text-center text-lg font-semibold">{range}</h2>
        <Button asChild size="icon" variant="ghost" aria-label={labels.next}>
          <Link href={`/calendar?view=week&w=${shift(7)}`}>
            <ChevronRight />
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href="/calendar?view=week">{labels.today}</Link>
        </Button>
      </div>
      <ol className="grid gap-2 md:grid-cols-7">
        {days.map((d) => {
          const own = events
            .filter((e) => (e.allDay ? iso(e.startsAt) : localDay(e.startsAt)) === iso(d))
            .sort((a, b) => Number(b.allDay) - Number(a.allDay) || +a.startsAt - +b.startsAt);
          const isToday = iso(d) === today;
          return (
            <li
              key={iso(d)}
              aria-label={dayName.format(d)}
              className={cn(
                'grid min-h-24 content-start gap-1.5 rounded-lg border border-border bg-card p-2 text-xs',
                isToday && 'border-accent',
              )}
            >
              <Link
                href={`/calendar?view=day&d=${iso(d)}`}
                className={cn(
                  'text-sm font-medium capitalize hover:underline',
                  isToday ? 'text-accent' : 'text-muted-foreground',
                )}
              >
                {dayName.format(d)}
              </Link>
              {own.length ? (
                own.map((e) => (
                  <div key={e.id} className="rounded bg-accent-soft px-1.5 py-1 text-accent">
                    <span className="block text-[11px] font-semibold tabular-nums">
                      {e.allDay ? labels.allDay : time.format(e.startsAt)}
                    </span>
                    {e.activityId && e.courseId ? (
                      <Link
                        href={`/course/${e.courseId}/a/${e.activityId}`}
                        className="break-words hover:underline"
                      >
                        {e.title}
                      </Link>
                    ) : (
                      <span className="break-words">{e.title}</span>
                    )}
                  </div>
                ))
              ) : (
                <span className="text-muted-foreground md:hidden">{labels.none}</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * One day: what lasts all day (or runs over from other days) first, then the hours of the
 * working day, wider when events come earlier or later, each with what starts in it.
 */
function DayView({
  day,
  events,
  localDay,
  today,
  locale,
  timeZone,
  labels,
}: {
  day: Date;
  events: CalendarEvent[];
  localDay: (d: Date) => string;
  today: string;
  locale: string;
  timeZone: string;
  labels: {
    prev: string;
    next: string;
    today: string;
    allDay: string;
    none: string;
    kinds: Record<string, string>;
  };
}) {
  const iso = day.toISOString().slice(0, 10);
  const shift = (n: number) => new Date(day.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  // an all-day event's days are dates (UTC midnights, the last one included)
  const dayOf = (d: Date, allDay: boolean) => (allDay ? d.toISOString().slice(0, 10) : localDay(d));
  const own = events.filter(
    (e) => dayOf(e.startsAt, e.allDay) <= iso && dayOf(e.endsAt ?? e.startsAt, e.allDay) >= iso,
  );
  const whole = own.filter((e) => e.allDay || localDay(e.startsAt) < iso);
  const timed = own.filter((e) => !whole.includes(e)).sort((a, b) => +a.startsAt - +b.startsAt);
  const hourOf = (d: Date) =>
    Number(
      new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(d),
    );
  const first = Math.min(8, ...timed.map((e) => hourOf(e.startsAt)));
  const last = Math.max(18, ...timed.map((e) => hourOf(e.startsAt)));
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone });
  const title = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(day);
  const item = (e: CalendarEvent) => (
    <div key={e.id} className="grid gap-0.5 rounded bg-accent-soft px-2 py-1.5 text-sm text-accent">
      <span className="flex flex-wrap items-baseline gap-x-2">
        {e.allDay || whole.includes(e) ? null : (
          <span className="text-xs font-semibold tabular-nums">
            {e.endsAt ? time.formatRange(e.startsAt, e.endsAt) : time.format(e.startsAt)}
          </span>
        )}
        {e.activityId && e.courseId ? (
          <Link
            href={`/course/${e.courseId}/a/${e.activityId}`}
            className="font-medium hover:underline"
          >
            {e.title}
          </Link>
        ) : (
          <span className="font-medium break-words">{e.title}</span>
        )}
      </span>
      <span className="text-xs text-foreground/70">
        {[labels.kinds[e.kind], e.courseName, e.location].filter(Boolean).join(' · ')}
      </span>
    </div>
  );
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="icon" variant="ghost" aria-label={labels.prev}>
          <Link href={`/calendar?view=day&d=${shift(-1)}`}>
            <ChevronLeft />
          </Link>
        </Button>
        <h2 className="min-w-44 text-center text-lg font-semibold first-letter:uppercase">
          {title}
        </h2>
        <Button asChild size="icon" variant="ghost" aria-label={labels.next}>
          <Link href={`/calendar?view=day&d=${shift(1)}`}>
            <ChevronRight />
          </Link>
        </Button>
        {iso === today ? null : (
          <Button asChild size="sm" variant="outline">
            <Link href="/calendar?view=day">{labels.today}</Link>
          </Button>
        )}
      </div>
      {whole.length ? (
        <section
          aria-label={labels.allDay}
          className="grid gap-1.5 rounded-lg border border-border bg-card p-2"
        >
          <span className="text-xs font-medium text-muted-foreground">{labels.allDay}</span>
          {whole.map(item)}
        </section>
      ) : null}
      {own.length === 0 ? <p className="text-sm text-muted-foreground">{labels.none}</p> : null}
      <ol className="grid rounded-lg border border-border bg-card">
        {Array.from({ length: last - first + 1 }, (_, i) => first + i).map((h) => {
          const at = timed.filter((e) => hourOf(e.startsAt) === h);
          return (
            <li
              key={h}
              className="grid min-h-10 grid-cols-[3.5rem_1fr] gap-2 border-b border-border px-2 py-1 last:border-b-0"
            >
              <span className="pt-1 text-xs tabular-nums text-muted-foreground">
                {String(h).padStart(2, '0')}:00
              </span>
              <div className="grid content-start gap-1">{at.map(item)}</div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
