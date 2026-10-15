import { reportForEdit, roleName } from '@hubium/core';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  PageHeader,
  Select,
  Textarea,
} from '@hubium/ui';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CommandButton } from '@/components/confirm-button';
import { ReportEditor } from '@/components/reports/report-editor';
import {
  deleteReportAction,
  deleteScheduleAction,
  duplicateReportAction,
  saveAudiencesAction,
  saveScheduleAction,
  sendScheduleAction,
} from '@/server/actions/reports';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('customReports', 'title');

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export default async function EditReportPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { ctx } = await requireCapability('report:customise');
  const { reportId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(reportId)) notFound();
  const data = await reportForEdit(ctx, reportId).catch(() => null);
  if (!data) notFound();
  const [t, tc, format, locale, roles, cohorts, users] = await Promise.all([
    getTranslations('customReports'),
    getTranslations('common'),
    getFormatter(),
    getLocale(),
    db.role.findMany({ orderBy: { sortOrder: 'asc' } }),
    db.cohort.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    db.user.findMany({
      where: {
        id: {
          in: [...data.audiences.userIds, ...data.report.schedules.flatMap((s) => s.userIds)],
        },
      },
      select: { id: true, email: true, username: true, name: true },
    }),
  ]);
  const r = data.report;
  const d = data.definition;
  const login = (id: string) => {
    const u = users.find((x) => x.id === id);
    return u ? (u.username ?? u.email) : '';
  };
  const date = (x: Date | null) =>
    x ? format.dateTime(x, { dateStyle: 'medium', timeStyle: 'short' }) : t('never');
  return (
    <>
      <PageHeader
        title={r.name}
        description={
          <span className="flex flex-wrap gap-x-3">
            <Link href={`/reports/${r.id}`} className="hover:underline">
              ← {t('view')}
            </Link>
            <span>{t(`sources.${r.source}`)}</span>
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <CommandButton
              size="sm"
              variant="secondary"
              run={duplicateReportAction.bind(null, r.id, `${r.name} (${t('copy')})`)}
            >
              {t('duplicate')}
            </CommandButton>
            <CommandButton
              size="sm"
              variant="destructive"
              confirm={`${tc('delete')}: ${r.name}?`}
              run={deleteReportAction.bind(null, r.id)}
            >
              {tc('delete')}
            </CommandButton>
          </div>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
        <Card className="min-w-0">
          <CardContent className="pt-6">
            <ReportEditor
              report={{
                id: r.id,
                name: r.name,
                columns: d.columns,
                conditions: d.conditions,
                filters: d.filters,
                sort: d.sort,
              }}
              fields={data.fields}
            />
          </CardContent>
        </Card>
        <div className="grid h-fit gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('audiences')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ActionForm action={saveAudiencesAction} success={tc('saved')} className="grid gap-3">
                <input type="hidden" name="id" value={r.id} />
                <p className="text-xs text-muted-foreground">{t('audiencesHint')}</p>
                <label htmlFor="aud-all" className="flex items-center gap-2 text-sm">
                  <Checkbox id="aud-all" name="all" defaultChecked={data.audiences.all} />
                  {t('audienceAll')}
                </label>
                <fieldset className="grid gap-1 text-sm">
                  <legend className="mb-1 font-medium">{t('roles')}</legend>
                  {roles.map((role) => (
                    <label
                      key={role.id}
                      htmlFor={`aud-role-${role.id}`}
                      className="flex items-center gap-2"
                    >
                      <Checkbox
                        id={`aud-role-${role.id}`}
                        name="roleIds"
                        value={role.id}
                        defaultChecked={data.audiences.roleIds.includes(role.id)}
                      />
                      {roleName(role, locale)}
                    </label>
                  ))}
                </fieldset>
                {cohorts.length ? (
                  <fieldset className="grid gap-1 text-sm">
                    <legend className="mb-1 font-medium">{t('cohorts')}</legend>
                    {cohorts.map((c) => (
                      <label
                        key={c.id}
                        htmlFor={`aud-cohort-${c.id}`}
                        className="flex items-center gap-2"
                      >
                        <Checkbox
                          id={`aud-cohort-${c.id}`}
                          name="cohortIds"
                          value={c.id}
                          defaultChecked={data.audiences.cohortIds.includes(c.id)}
                        />
                        {c.name}
                      </label>
                    ))}
                  </fieldset>
                ) : null}
                <FormField name="logins" id="aud-logins" label={t('people')} hint={t('peopleHint')}>
                  <Textarea
                    id="aud-logins"
                    name="logins"
                    defaultValue={data.audiences.userIds.map(login).join('\n')}
                  />
                </FormField>
                <div>
                  <SubmitButton>{tc('save')}</SubmitButton>
                </div>
              </ActionForm>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('schedules')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {r.schedules.length ? (
                <ul className="grid gap-2 text-sm">
                  {r.schedules.map((s) => (
                    <li key={s.id} className="grid gap-1 rounded-md border border-border p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{s.name}</span>
                        {s.enabled ? null : <Badge variant="neutral">{tc('disabled')}</Badge>}
                      </div>
                      <span className="text-muted-foreground">
                        {t(`frequencies.${s.frequency}`)}, {String(s.hour).padStart(2, '0')}:00 ·{' '}
                        {s.format.toUpperCase()}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t('lastRun')}: {date(s.lastRunAt)} · {t('nextRun')}: {date(s.nextRunAt)}
                      </span>
                      <div className="flex flex-wrap gap-2">
                        <CommandButton
                          size="sm"
                          variant="secondary"
                          run={sendScheduleAction.bind(null, r.id, s.id)}
                          success={t('sent')}
                        >
                          {t('sendNow')}
                        </CommandButton>
                        <CommandButton
                          size="sm"
                          variant="ghost"
                          confirm={`${tc('delete')}: ${s.name}?`}
                          run={deleteScheduleAction.bind(null, r.id, s.id)}
                        >
                          {tc('delete')}
                        </CommandButton>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('noSchedules')}</p>
              )}
              <ActionForm
                action={saveScheduleAction}
                success={tc('saved')}
                resetOnSuccess
                className="grid gap-3 border-t border-border pt-4"
              >
                <input type="hidden" name="reportId" value={r.id} />
                <h3 className="text-sm font-medium">{t('newSchedule')}</h3>
                <FormField name="name" id="sch-name" label={t('name')} required />
                <div className="grid grid-cols-2 gap-3">
                  <FormField name="frequency" id="sch-frequency" label={t('frequency')}>
                    <Select id="sch-frequency" name="frequency" defaultValue="WEEKLY">
                      {(['DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY'] as const).map((f) => (
                        <option key={f} value={f}>
                          {t(`frequencies.${f}`)}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField name="hour" id="sch-hour" label={t('hour')}>
                    <Select id="sch-hour" name="hour" defaultValue="8">
                      {HOURS.map((h) => (
                        <option key={h} value={String(h)}>
                          {String(h).padStart(2, '0')}:00
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField
                    name="day"
                    id="sch-day"
                    type="number"
                    min={1}
                    max={28}
                    defaultValue={1}
                    label={t('day')}
                    hint={t('dayHint')}
                  />
                  <FormField name="format" id="sch-format" label={t('format')}>
                    <Select id="sch-format" name="format" defaultValue="xlsx">
                      <option value="xlsx">XLSX</option>
                      <option value="csv">CSV</option>
                    </Select>
                  </FormField>
                </div>
                <FormField
                  name="logins"
                  id="sch-logins"
                  label={t('recipients')}
                  hint={t('peopleHint')}
                >
                  <Textarea id="sch-logins" name="logins" />
                </FormField>
                <label htmlFor="sch-audience" className="flex items-center gap-2 text-sm">
                  <Checkbox id="sch-audience" name="toAudience" />
                  {t('toAudience')}
                </label>
                <label htmlFor="sch-skip" className="flex items-center gap-2 text-sm">
                  <Checkbox id="sch-skip" name="skipEmpty" defaultChecked />
                  {t('skipEmpty')}
                </label>
                <div>
                  <SubmitButton variant="secondary">{tc('add')}</SubmitButton>
                </div>
              </ActionForm>
              <Button asChild variant="ghost" size="sm" className="justify-self-start">
                <Link href={`/reports/${r.id}`}>{t('view')}</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
