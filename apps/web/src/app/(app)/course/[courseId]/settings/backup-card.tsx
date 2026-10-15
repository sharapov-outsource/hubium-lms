'use client';

import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Progress,
  Select,
} from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { Archive, Copy, Download, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CommandButton } from '@/components/confirm-button';
import {
  backupStatusAction,
  deleteBackupAction,
  duplicateCourseAction,
  startBackupAction,
} from '@/server/actions/interchange';

type Task = Extract<Awaited<ReturnType<typeof backupStatusAction>>, { ok: true }>['data'];

export function BackupCard({
  courseId,
  fullName,
  shortName,
  categoryId,
  categories,
  canDuplicate,
  backups,
  kept,
  runningTaskId,
}: {
  courseId: string;
  fullName: string;
  shortName: string;
  categoryId: string;
  categories: { id: string; name: string; depth: number }[];
  canDuplicate: boolean;
  /** The course's backups, newest first. */
  backups: { id: string; name: string; size: number; createdAt: Date; url: string }[];
  /** How many backups are kept. */
  kept: number;
  /** A backup this user started that is still being made. */
  runningTaskId: string | null;
}) {
  const t = useTranslations('backup');
  const format = useFormatter();
  const router = useRouter();
  const [taskId, setTaskId] = useState(runningTaskId);
  const [task, setTask] = useState<Task | null>(null);
  const [starting, setStarting] = useState(false);

  // the backup is made by the worker: its progress is asked for until it is done
  useEffect(() => {
    if (!taskId) return;
    let stop = false;
    const tick = async () => {
      const r = await backupStatusAction(taskId);
      if (stop) return;
      if (r.ok) {
        setTask(r.data);
        if (r.data.status === 'SUCCEEDED') {
          toast.success(t('created'));
          setTaskId(null);
          router.refresh();
          return;
        }
        if (r.data.status === 'FAILED' || r.data.status === 'CANCELLED') {
          setTaskId(null);
          return;
        }
      }
      setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [taskId, router, t]);

  async function start() {
    setStarting(true);
    setTask(null);
    const r = await startBackupAction(courseId);
    setStarting(false);
    if (r.ok) setTaskId(r.data.taskId);
    else toast.error(r.message);
  }

  const busy = starting || taskId !== null;
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{t('downloadHint')}</p>
            <Button variant="outline" disabled={busy} onClick={start}>
              <Archive />
              {t('create')}
            </Button>
          </div>
          {busy ? (
            <div className="grid gap-1" aria-live="polite">
              <span className="text-sm text-muted-foreground">{t('creating')}</span>
              <Progress value={task?.progress ?? 0} label={`${task?.progress ?? 0}%`} />
            </div>
          ) : null}
          {!busy && task?.status === 'FAILED' ? (
            <Alert variant="destructive">{t('createFailed', { error: task.error ?? '' })}</Alert>
          ) : null}
          <div className="grid gap-2">
            <h3 className="font-medium">{t('backups')}</h3>
            {backups.length ? (
              <ul className="divide-y rounded-md border">
                {backups.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                    <a
                      href={b.url}
                      download={b.name}
                      className="inline-flex min-w-0 items-center gap-1.5 font-medium break-all hover:underline"
                    >
                      <Download className="size-4 shrink-0" aria-hidden />
                      {b.name}
                    </a>
                    <span className="text-sm text-muted-foreground">
                      {format.number(b.size / 1_048_576, {
                        style: 'unit',
                        unit: 'megabyte',
                        maximumFractionDigits: 1,
                      })}
                      {' · '}
                      {format.dateTime(new Date(b.createdAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </span>
                    <CommandButton
                      className="ml-auto"
                      variant="ghost"
                      size="sm"
                      aria-label={t('deleteBackup', { name: b.name })}
                      confirm={t('deleteBackupConfirm', { name: b.name })}
                      run={deleteBackupAction.bind(null, b.id)}
                    >
                      <Trash2 />
                    </CommandButton>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('noBackups')}</p>
            )}
            <p className="text-xs text-muted-foreground">{t('keptHint', { n: kept })}</p>
          </div>
        </div>
        {canDuplicate ? (
          <ActionForm action={duplicateCourseAction} className="grid gap-3 border-t pt-4">
            <h3 className="font-medium">{t('duplicate')}</h3>
            <input type="hidden" name="courseId" value={courseId} />
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                name="fullName"
                label={t('fullName')}
                defaultValue={t('copyOf', { name: fullName })}
                required
              />
              <FormField
                name="shortName"
                label={t('shortName')}
                defaultValue={`${shortName}-copy`}
                required
              />
            </div>
            <FormField name="categoryId" label={t('category')}>
              <Select id="f-categoryId" name="categoryId" defaultValue={categoryId}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {'  '.repeat(c.depth)}
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <SubmitButton className="w-fit">
              <Copy />
              {t('duplicateSubmit')}
            </SubmitButton>
          </ActionForm>
        ) : null}
      </CardContent>
    </Card>
  );
}
