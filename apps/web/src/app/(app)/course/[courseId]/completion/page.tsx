import { completionReport } from '@hubium/core';
import { EmptyState, Progress } from '@hubium/ui';
import { forbidden } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getContext } from '@/server/session';
import { CompletionCell } from './cell';

export default async function CompletionPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  const ctx = await getContext();
  if (!(await ctx.perm.can('completion:viewreports', courseId))) forbidden();
  const [t, tm] = await Promise.all([getTranslations('completionReport'), getTranslations('mod')]);
  const report = await completionReport(ctx, courseId);
  const canOverride = await ctx.perm.can('completion:override', courseId);
  if (!report.activities.length) return <EmptyState title={t('empty')} />;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">{t('title')}</caption>
        <thead className="bg-surface">
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-medium"
            >
              {t('learner')}
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t('progress')}
            </th>
            {report.activities.map((a) => (
              <th
                key={a.id}
                scope="col"
                className="min-w-24 px-2 py-2 text-left align-bottom text-xs font-medium"
              >
                <span className="line-clamp-3" title={a.name}>
                  {a.name}
                </span>
                <span className="block font-normal text-muted-foreground">
                  {tm(`${a.moduleKey}.name` as never)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {report.learners.map((l) => (
            <tr key={l.id}>
              <th
                scope="row"
                className="sticky left-0 bg-card px-3 py-2 text-left font-medium whitespace-nowrap"
              >
                {l.name}
              </th>
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <Progress
                    value={l.progress}
                    label={`${l.name}: ${l.progress}%`}
                    className="w-20"
                  />
                  <span className="tabular-nums text-xs">{l.progress}%</span>
                </div>
              </td>
              {l.cells.map((state, i) => (
                <td key={report.activities[i]!.id} className="px-2 py-2">
                  <CompletionCell
                    courseId={courseId}
                    activityId={report.activities[i]!.id}
                    userId={l.id}
                    state={state}
                    label={`${l.name} — ${report.activities[i]!.name}: ${t(`states.${state}`)}`}
                    canOverride={canOverride}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
