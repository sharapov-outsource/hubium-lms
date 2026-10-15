'use client';

import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
} from '@hubium/ui';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@hubium/ui/dialog';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState, useTransition } from 'react';
import { resetCourseAction } from '@/server/actions/courses';

function Option({
  name,
  value,
  label,
  defaultChecked,
}: {
  name: string;
  value?: string;
  label: string;
  defaultChecked?: boolean;
}) {
  const id = `r-${name}-${value ?? 'on'}`;
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm">
      <Checkbox
        id={id}
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="mt-0.5"
      />
      {label}
    </label>
  );
}

export function ResetForm({
  courseId,
  startDate,
  modules,
  roles,
  counts,
}: {
  courseId: string;
  startDate: string;
  modules: { key: string; name: string; activities: number }[];
  roles: { id: string; name: string; people: number; student: boolean }[];
  counts: {
    grades: number;
    completions: number;
    groups: number;
    events: number;
    announcements: number;
  };
}) {
  const t = useTranslations('courseReset');
  const tc = useTranslations('common');
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [report, setReport] = useState<string | null>(null);

  function run() {
    const fd = new FormData(form.current!);
    start(async () => {
      const r = await resetCourseAction(courseId, fd);
      if (!r.ok) return void toast.error(r.message);
      const d = r.data;
      setReport(
        t('done', {
          activities: d.activities,
          grades: d.grades,
          unenrolled: d.unenrolled,
          days: d.shiftedDays,
        }),
      );
      router.refresh();
    });
  }

  return (
    <form ref={form} className="grid gap-6" onSubmit={(e) => e.preventDefault()}>
      <Card>
        <CardHeader>
          <CardTitle>{t('dates')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          <label htmlFor="r-startDate" className="text-sm font-medium">
            {t('startDate')}
          </label>
          <Input
            id="r-startDate"
            name="startDate"
            type="date"
            defaultValue={startDate}
            className="w-48"
          />
          <p className="text-xs text-muted-foreground">{t('startDateHint')}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('learnersData')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {modules.map((m) => (
            <Option
              key={m.key}
              name="activityData"
              value={m.key}
              label={t('moduleData', { name: m.name, count: m.activities })}
            />
          ))}
          <Option name="grades" label={t('grades', { count: counts.grades })} />
          <Option name="completion" label={t('completion', { count: counts.completions })} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('people')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {roles.map((r) => (
            <Option
              key={r.id}
              name="unenrolRoleIds"
              value={r.id}
              label={t('unenrol', { role: r.name, count: r.people })}
            />
          ))}
          <Option name="groupMembers" label={t('groupMembers')} />
          <Option name="groups" label={t('groups', { count: counts.groups })} />
          <Option name="groupings" label={t('groupings')} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('other')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          <Option name="events" label={t('events', { count: counts.events })} />
          <Option
            name="announcements"
            label={t('announcements', { count: counts.announcements })}
          />
        </CardContent>
      </Card>
      {report ? <Alert variant="success">{report}</Alert> : null}
      <div>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="destructive" disabled={pending}>
              {t('submit')}
            </Button>
          </DialogTrigger>
          <DialogContent title={t('confirmTitle')}>
            <p className="text-sm">{t('confirm')}</p>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">{tc('cancel')}</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button variant="destructive" onClick={run}>
                  {t('submit')}
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </form>
  );
}
