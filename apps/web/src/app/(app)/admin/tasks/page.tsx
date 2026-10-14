import { type TaskRun, type TaskState, taskLog, taskOverview } from '@hubium/core';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  Select,
} from '@hubium/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import { CommandButton } from '@/components/confirm-button';
import { Pagination } from '@/components/pagination';
import { retryTaskRunAction, runTaskNowAction } from '@/server/actions/tasks';
import { titled } from '@/server/page-title';
import { getContext, requireCapability } from '@/server/session';

export const generateMetadata = titled('tasks', 'title');

const STATES: TaskState[] = ['created', 'retry', 'active', 'completed', 'cancelled', 'failed'];
const VARIANT = {
  created: 'neutral',
  retry: 'warning',
  active: 'accent',
  completed: 'success',
  cancelled: 'neutral',
  failed: 'destructive',
} as const;

// Administration → Tasks: what the worker runs on a schedule and how it went, as in
// Moodle's scheduled tasks and task log.

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ name?: string; state?: string; page?: string }>;
}) {
  await requireCapability('site:config');
  const sp = await searchParams;
  const ctx = await getContext();
  const state = STATES.includes(sp.state as TaskState) ? (sp.state as TaskState) : undefined;
  const [t, format, tasks, log] = await Promise.all([
    getTranslations('tasks'),
    getFormatter(),
    taskOverview(ctx),
    taskLog(ctx, { name: sp.name || undefined, state, page: Number(sp.page) || 1 }),
  ]);
  const label = (name: string) => {
    const key = `names.${name.replaceAll('.', '_')}`;
    return t.has(key as never) ? t(key as never) : name;
  };
  const duration = (ms: number | null) =>
    ms === null
      ? ''
      : ms < 1000
        ? t('ms', { n: ms })
        : t('seconds', { n: format.number(ms / 1000, { maximumFractionDigits: 1 }) });
  const when = (d: Date) => format.dateTime(d, { dateStyle: 'short', timeStyle: 'medium' });
  const stateBadge = (r: TaskRun) => (
    <Badge variant={VARIANT[r.state]}>{t(`states.${r.state}`)}</Badge>
  );

  return (
    <div className="grid max-w-5xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      <Card>
        <CardHeader>
          <CardTitle>{t('scheduled')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid divide-y divide-border">
            {tasks.map((task) => (
              <li
                key={task.name}
                className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-center"
                aria-label={label(task.name)}
              >
                <div className="grid min-w-0 gap-1">
                  <p className="font-medium">{label(task.name)}</p>
                  <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <code>{task.name}</code>
                    <span>
                      {t('schedule')}: <code>{task.cron}</code> UTC
                    </span>
                  </p>
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    {task.last ? (
                      <>
                        {stateBadge(task.last)}
                        <span>
                          {t('lastRun', { time: format.relativeTime(task.last.startedAt!) })}
                        </span>
                        {task.last.durationMs !== null ? (
                          <span className="text-muted-foreground">
                            {duration(task.last.durationMs)}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">{t('neverRun')}</span>
                    )}
                  </p>
                  {task.lastFailure &&
                  (!task.last || task.lastFailure.createdAt >= task.last.createdAt) ? (
                    <p className="break-words text-xs text-destructive">
                      {t('lastFailure', { time: when(task.lastFailure.createdAt) })}:{' '}
                      {task.lastFailure.error ?? '—'}
                    </p>
                  ) : null}
                </div>
                <CommandButton
                  size="sm"
                  variant="outline"
                  run={runTaskNowAction.bind(null, task.name)}
                  success={t('queued')}
                  aria-label={`${t('runNow')}: ${label(task.name)}`}
                >
                  {t('runNow')}
                </CommandButton>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('log')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">{t('logHint')}</p>
          <form className="flex flex-wrap items-end gap-3">
            <label htmlFor="log-name" className="grid gap-1 text-sm">
              {t('task')}
              <Select
                id="log-name"
                name="name"
                defaultValue={sp.name ?? ''}
                className="w-64 max-w-full"
              >
                <option value="">{t('allTasks')}</option>
                {log.names.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
            <label htmlFor="log-state" className="grid gap-1 text-sm">
              {t('state')}
              <Select id="log-state" name="state" defaultValue={state ?? ''} className="w-48">
                <option value="">{t('allStates')}</option>
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {t(`states.${s}`)}
                  </option>
                ))}
              </Select>
            </label>
            <Button type="submit" variant="outline">
              {t('filter')}
            </Button>
          </form>
          {log.items.length ? (
            <ul className="grid divide-y divide-border" aria-label={t('log')}>
              {log.items.map((r) => (
                <li
                  key={r.id}
                  className="grid gap-1 py-2 text-sm sm:grid-cols-[1fr_auto] sm:items-center"
                >
                  <div className="grid min-w-0 gap-1">
                    <p className="flex flex-wrap items-center gap-2">
                      {stateBadge(r)}
                      <span className="font-medium">{label(r.name)}</span>
                      <span className="text-xs text-muted-foreground">{when(r.createdAt)}</span>
                      {r.durationMs !== null ? (
                        <span className="text-xs text-muted-foreground">
                          {duration(r.durationMs)}
                        </span>
                      ) : null}
                      {r.retries ? (
                        <span className="text-xs text-muted-foreground">
                          {t('retries', { n: r.retries })}
                        </span>
                      ) : null}
                    </p>
                    {r.error ? (
                      <p className="break-words text-xs text-destructive">{r.error}</p>
                    ) : null}
                  </div>
                  {r.state === 'failed' ? (
                    <CommandButton
                      size="sm"
                      variant="outline"
                      run={retryTaskRunAction.bind(null, r.name, r.id)}
                      success={t('queued')}
                    >
                      {t('retry')}
                    </CommandButton>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('emptyLog')}</p>
          )}
          <Pagination
            page={log.page}
            pageSize={log.pageSize}
            total={log.total}
            params={{ name: sp.name, state }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
