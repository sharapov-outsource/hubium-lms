'use client';

import { ActionFailure, uploadResumable, useFailureText } from '@hubium/module-sdk/form';
import { Alert, Button, Card, CardContent, Field, Input, Progress, Select } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { importStatusAction, startImportAction } from '@/server/actions/interchange';

type Status = Awaited<ReturnType<typeof importStatusAction>>;
type Task = Extract<Status, { ok: true }>['data'];

export function CourseImporter({
  categories,
}: {
  categories: { id: string; name: string; depth: number; hubium: boolean; mbz: boolean }[];
}) {
  const t = useTranslations('backup');
  const failed = useFailureText();
  const [categoryId, setCategoryId] = useState(categories[0]!.id);
  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<number | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<Task | null>(null);

  const kind = file?.name.toLowerCase().endsWith('.mbz') ? 'mbz' : 'hubium';
  const cat = categories.find((c) => c.id === categoryId)!;
  const allowed = kind === 'mbz' ? cat.mbz : cat.hubium;
  const busy = upload !== null || (taskId !== null && !task?.status.match(/SUCCEEDED|FAILED/));

  useEffect(() => {
    if (!taskId) return;
    let stop = false;
    const tick = async () => {
      const r = await importStatusAction(taskId);
      if (stop) return;
      if (r.ok) {
        setTask(r.data);
        if (r.data.status === 'SUCCEEDED' || r.data.status === 'FAILED') return;
      }
      setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [taskId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setTask(null);
    setTaskId(null);
    setUpload(0);
    try {
      const uploadId = await uploadResumable(file, { onProgress: setUpload });
      const r = await startImportAction({ uploadId, categoryId, kind });
      if (!r.ok) throw new ActionFailure(r.message ?? '');
      setTaskId(r.data.taskId);
    } catch (err) {
      toast.error(failed(err));
    } finally {
      setUpload(null);
    }
  }

  const progress = upload !== null ? upload * 100 : (task?.progress ?? 0);
  return (
    <Card className="max-w-3xl">
      <CardContent className="grid gap-4 pt-5">
        <form onSubmit={submit} className="grid gap-4">
          <Field label={t('file')} htmlFor="import-file" hint={t('fileHint')}>
            <Input
              id="import-file"
              type="file"
              accept=".hubium,.mbz,application/zip,application/gzip"
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          <Field label={t('category')} htmlFor="import-category">
            <Select
              id="import-category"
              value={categoryId}
              disabled={busy}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {'  '.repeat(c.depth)}
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          {file && !allowed ? <Alert variant="warning">{t('notAllowed')}</Alert> : null}
          <Button type="submit" className="w-fit" disabled={!file || !allowed || busy}>
            {t('importSubmit')}
          </Button>
        </form>
        {busy ? (
          <div className="grid gap-1" aria-live="polite">
            <span className="text-sm text-muted-foreground">
              {upload !== null ? t('uploading') : t('processing')}
            </span>
            <Progress value={Math.round(progress)} label={`${Math.round(progress)}%`} />
          </div>
        ) : null}
        {task?.status === 'FAILED' ? (
          <Alert variant="destructive">{t('failed', { error: task.error ?? '' })}</Alert>
        ) : null}
        {task?.status === 'SUCCEEDED' && task.result ? (
          <Alert variant={task.result.warnings.length ? 'warning' : 'success'}>
            <p>
              {t('done', {
                sections: task.result.sections,
                activities: task.result.activities,
                questions: task.result.questions,
                files: task.result.files,
              })}
            </p>
            {task.result.warnings.length ? (
              <ul className="mt-1 list-disc pl-5">
                {task.result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
            <Button asChild size="sm" className="mt-2">
              <Link href={`/course/${task.result.courseId}`}>{t('openCourse')}</Link>
            </Button>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
