'use client';

import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Checkbox } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { importActivitiesAction } from '@/server/actions/interchange';

interface Section {
  id: string;
  title: string;
  activities: { id: string; name: string; type: string }[];
}

export function ImportForm({
  targetCourseId,
  source,
  sections,
}: {
  targetCourseId: string;
  source: { id: string; name: string };
  sections: Section[];
}) {
  const t = useTranslations('courseImport');
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [report, setReport] = useState<{ text: string; warnings: string[] } | null>(null);
  const all = sections.flatMap((s) => s.activities.map((a) => a.id));

  function toggle(ids: string[], on: boolean) {
    setSelected((cur) => {
      const next = new Set(cur);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  }

  function run() {
    start(async () => {
      const r = await importActivitiesAction({
        targetCourseId,
        sourceCourseId: source.id,
        activityIds: [...selected],
      });
      if (!r.ok) return void toast.error(r.message);
      setReport({
        text: t('done', {
          activities: r.data.activities,
          sections: r.data.sections,
          questions: r.data.questions,
        }),
        warnings: r.data.warnings,
      });
      setSelected(new Set());
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          {t('from')} <strong>{source.name}</strong>
        </span>
        <Link href={`/course/${targetCourseId}/import`} className="text-primary underline">
          {t('another')}
        </Link>
      </div>
      {sections.length ? (
        <>
          <label htmlFor="imp-all" className="flex items-center gap-2 text-sm font-medium">
            <Checkbox
              id="imp-all"
              checked={selected.size === all.length}
              onChange={(e) => toggle(all, e.currentTarget.checked)}
            />
            {t('all')}
          </label>
          {sections.map((s) => {
            const ids = s.activities.map((a) => a.id);
            return (
              <Card key={s.id}>
                <CardHeader>
                  <CardTitle className="text-base">
                    <label htmlFor={`imp-s-${s.id}`} className="flex items-center gap-2">
                      <Checkbox
                        id={`imp-s-${s.id}`}
                        checked={ids.every((id) => selected.has(id))}
                        onChange={(e) => toggle(ids, e.currentTarget.checked)}
                      />
                      {s.title}
                    </label>
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {s.activities.map((a) => (
                    <label
                      key={a.id}
                      htmlFor={`imp-a-${a.id}`}
                      className="flex items-start gap-2 text-sm"
                    >
                      <Checkbox
                        id={`imp-a-${a.id}`}
                        checked={selected.has(a.id)}
                        onChange={(e) => toggle([a.id], e.currentTarget.checked)}
                        className="mt-0.5"
                      />
                      <span>
                        {a.name} <span className="text-muted-foreground">· {a.type}</span>
                      </span>
                    </label>
                  ))}
                </CardContent>
              </Card>
            );
          })}
          <p className="text-xs text-muted-foreground">{t('hint')}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={run} disabled={pending || !selected.size}>
              {pending ? t('importing') : t('submit', { count: selected.size })}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      )}
      {report ? (
        <Alert variant="success">
          <p>{report.text}</p>
          {report.warnings.length ? (
            <ul className="mt-2 list-disc pl-5 text-xs">
              {report.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2">
            <Link href={`/course/${targetCourseId}`} className="text-primary underline">
              {t('toCourse')}
            </Link>
          </p>
        </Alert>
      ) : null}
    </div>
  );
}
