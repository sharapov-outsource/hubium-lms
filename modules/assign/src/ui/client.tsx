'use client';

import { RichTextEditor } from '@hubium/editor/client';
import { useEditorLabels } from '@hubium/editor/field';
import { callModuleAction, DateTimeInput } from '@hubium/module-sdk/form';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Label,
} from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState, useTransition } from 'react';

function useAction(activityId: string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (
    action: string,
    input: Record<string, unknown>,
    files?: File[],
    done?: () => void,
    okMsg?: string,
  ) =>
    start(async () => {
      const r = await callModuleAction(
        activityId,
        action,
        input,
        files?.length ? { list: files } : undefined,
      );
      if (!r.ok) {
        toast.error(r.message ?? 'Error');
        return;
      }
      if (okMsg) toast.success(okMsg);
      done?.();
      router.refresh();
    });
  return { pending, run };
}

export function SubmissionForm({
  activityId,
  courseId,
  allowText,
  allowFiles,
  maxFiles,
  submitButton,
  text,
  files,
}: {
  activityId: string;
  courseId: string;
  allowText: boolean;
  allowFiles: boolean;
  maxFiles: number;
  submitButton: boolean;
  text: string;
  files: { id: string; name: string; url: string }[];
}) {
  const t = useTranslations('mod.assign');
  const labels = useEditorLabels();
  const { pending, run } = useAction(activityId);
  const formRef = useRef<HTMLFormElement>(null);
  const [remove, setRemove] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  void courseId;
  const send = (submit: boolean) => {
    const fd = new FormData(formRef.current!);
    const newFiles = fd
      .getAll('newFiles')
      .filter((f): f is File => f instanceof File && f.size > 0);
    run(
      'saveSubmission',
      { text: String(fd.get('text') ?? ''), submit, removeFiles: [...remove] },
      newFiles,
      () => {
        setRemove(new Set());
        setConfirm(false);
        formRef.current?.querySelectorAll<HTMLInputElement>('input[type=file]').forEach((i) => {
          i.value = '';
        });
      },
      submit ? t('submitted') : t('saved'),
    );
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('yourText')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form ref={formRef} className="grid gap-4" onSubmit={(e) => e.preventDefault()}>
          {allowText ? (
            <div className="grid gap-1.5">
              <Label htmlFor="assign-text">{t('yourText')}</Label>
              <RichTextEditor
                id="assign-text"
                name="text"
                defaultValue={text}
                labels={labels}
                ariaLabel={t('yourText')}
                minHeight={200}
              />
            </div>
          ) : null}
          {allowFiles ? (
            <div className="grid gap-2">
              <span className="text-sm font-medium">{t('yourFiles')}</span>
              {files.map((f) => (
                <label
                  key={f.id}
                  htmlFor={`rm-${f.id}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox
                    id={`rm-${f.id}`}
                    checked={remove.has(f.id)}
                    onChange={(e) => {
                      const n = new Set(remove);
                      if (e.target.checked) n.add(f.id);
                      else n.delete(f.id);
                      setRemove(n);
                    }}
                  />
                  <span className={remove.has(f.id) ? 'line-through' : ''}>
                    {t('removeFile')}:{' '}
                    <a href={f.url} className="text-accent hover:underline">
                      {f.name}
                    </a>
                  </span>
                </label>
              ))}
              {files.length - remove.size < maxFiles ? (
                <Field label={t('addFiles')} htmlFor="assign-files">
                  <Input id="assign-files" name="newFiles" type="file" multiple />
                </Field>
              ) : null}
            </div>
          ) : null}
          {confirm ? (
            <Alert variant="warning" className="grid gap-2">
              <span>{t('submitConfirm')}</span>
              <div className="flex gap-2">
                <Button type="button" disabled={pending} onClick={() => send(true)}>
                  {t('submit')}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirm(false)}>
                  ×
                </Button>
              </div>
            </Alert>
          ) : (
            <div className="flex flex-wrap gap-2">
              {submitButton ? (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={pending}
                    onClick={() => send(false)}
                  >
                    {t('saveDraft')}
                  </Button>
                  <Button type="button" disabled={pending} onClick={() => setConfirm(true)}>
                    {t('submit')}
                  </Button>
                </>
              ) : (
                <Button type="button" disabled={pending} onClick={() => send(false)}>
                  {t('submit')}
                </Button>
              )}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export function WithdrawButton({ activityId }: { activityId: string }) {
  const t = useTranslations('mod.assign');
  const { pending, run } = useAction(activityId);
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-fit"
      disabled={pending}
      onClick={() => run('revertToDraft', {})}
    >
      {t('withdraw')}
    </Button>
  );
}

export function GradeForm({
  activityId,
  userId,
  gradeMax,
  grade,
  feedback,
  canReopen,
  nextUrl,
}: {
  activityId: string;
  courseId: string;
  userId: string;
  gradeMax: number;
  grade: number | null;
  feedback: string;
  canReopen: boolean;
  nextUrl: string;
}) {
  const t = useTranslations('mod.assign');
  const labels = useEditorLabels();
  const router = useRouter();
  const { pending, run } = useAction(activityId);
  const formRef = useRef<HTMLFormElement>(null);
  const save = (goNext: boolean) => {
    const fd = new FormData(formRef.current!);
    const raw = String(fd.get('grade') ?? '')
      .replace(',', '.')
      .trim();
    const files = fd
      .getAll('feedbackFiles')
      .filter((f): f is File => f instanceof File && f.size > 0);
    run(
      'grade',
      {
        userId,
        grade: raw === '' ? null : Number(raw),
        feedback: String(fd.get('feedback') ?? ''),
        reopen: fd.get('reopen') === 'on',
      },
      files,
      () => {
        if (goNext) router.push(nextUrl);
      },
      t('gradeSaved'),
    );
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('grade')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form ref={formRef} className="grid gap-4" onSubmit={(e) => e.preventDefault()}>
          <Field label={`${t('grade')} (${t('outOf', { max: gradeMax })})`} htmlFor="assign-grade">
            <Input
              id="assign-grade"
              name="grade"
              inputMode="decimal"
              defaultValue={grade ?? ''}
              className="w-32"
            />
          </Field>
          <div className="grid gap-1.5">
            <Label htmlFor="assign-feedback">{t('feedback')}</Label>
            <RichTextEditor
              id="assign-feedback"
              name="feedback"
              defaultValue={feedback}
              labels={labels}
              ariaLabel={t('feedback')}
              minHeight={120}
            />
          </div>
          <Field label={t('feedbackFiles')} htmlFor="assign-ffiles">
            <Input id="assign-ffiles" name="feedbackFiles" type="file" multiple />
          </Field>
          {canReopen ? (
            <label htmlFor="assign-reopen" className="flex items-center gap-2 text-sm">
              <Checkbox id="assign-reopen" name="reopen" />
              {t('reopenAttempt')}
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={pending} onClick={() => save(false)}>
              {t('saveGrade')}
            </Button>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => save(true)}>
              {t('saveGrade')} → {t('next')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function ExtensionForm({
  activityId,
  userId,
  dueAt,
  hasOverride,
}: {
  activityId: string;
  userId: string;
  dueAt: string | null;
  hasOverride: boolean;
}) {
  const t = useTranslations('mod.assign');
  const { pending, run } = useAction(activityId);
  const ref = useRef<HTMLFormElement>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('extension')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form ref={ref} className="grid gap-3" onSubmit={(e) => e.preventDefault()}>
          <Field label={t('extensionDue')} htmlFor="assign-ext">
            <DateTimeInput id="assign-ext" name="dueAt" defaultValue={dueAt} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                const v = String(new FormData(ref.current!).get('dueAt') ?? '');
                if (v) run('extend', { userId, dueAt: v }, undefined, undefined, t('saved'));
              }}
            >
              {t('extension')}
            </Button>
            {hasOverride ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  run('extend', { userId, dueAt: null }, undefined, undefined, t('saved'))
                }
              >
                {t('removeExtension')}
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
