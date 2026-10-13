'use client';

import { RichTextEditor } from '@hubium/editor/client';
import { useEditorLabels } from '@hubium/editor/field';
import type { AiGradeSuggestion } from '@hubium/module-sdk';
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
  Select,
  Textarea,
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
            <div className="grid content-start gap-1.5">
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
  scale = null,
  grade,
  feedback,
  canReopen,
  nextUrl,
  ai,
}: {
  activityId: string;
  courseId: string;
  userId: string;
  gradeMax: number;
  /** Grades of the scale, worst first, when the assignment is graded on one. */
  scale?: string[] | null;
  grade: number | null;
  feedback: string;
  canReopen: boolean;
  nextUrl: string;
  ai?: { available: boolean; consentRequired: boolean; notice: string };
}) {
  const t = useTranslations('mod.assign');
  const labels = useEditorLabels();
  const router = useRouter();
  const { pending, run } = useAction(activityId);
  const formRef = useRef<HTMLFormElement>(null);
  // Applying an AI suggestion remounts the editor with the draft as its initial value.
  const [draft, setDraft] = useState<{ key: number; html: string } | null>(null);
  const [scaleGrade, setScaleGrade] = useState(grade === null ? '' : String(grade));
  const applySuggestion = (s: AiGradeSuggestion) => {
    // the assistant grades in points; on a scale take the matching share of its grades
    if (scale)
      setScaleGrade(
        String(
          Math.min(
            scale.length,
            Math.max(1, Math.round((s.suggestedGrade / s.gradeMax) * scale.length)),
          ),
        ),
      );
    else {
      const input = formRef.current?.elements.namedItem('grade') as HTMLInputElement | null;
      if (input) input.value = String(s.suggestedGrade);
    }
    setDraft((d) => ({ key: (d?.key ?? 0) + 1, html: textToHtml(s.feedbackDraft) }));
  };
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
      <CardContent className="grid gap-4">
        {ai?.available ? (
          <AiGradeAssist
            activityId={activityId}
            userId={userId}
            consentRequired={ai.consentRequired}
            notice={ai.notice}
            onApply={applySuggestion}
          />
        ) : null}
        <form ref={formRef} className="grid gap-4" onSubmit={(e) => e.preventDefault()}>
          {scale ? (
            <Field label={t('grade')} htmlFor="assign-grade">
              <Select
                id="assign-grade"
                name="grade"
                value={scaleGrade}
                onChange={(e) => setScaleGrade(e.target.value)}
                className="w-56"
              >
                <option value="">—</option>
                {scale.map((label, i) => (
                  <option key={label} value={i + 1}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field
              label={`${t('grade')} (${t('outOf', { max: gradeMax })})`}
              htmlFor="assign-grade"
            >
              <Input
                id="assign-grade"
                name="grade"
                inputMode="decimal"
                defaultValue={grade ?? ''}
                className="w-32"
              />
            </Field>
          )}
          <div className="grid content-start gap-1.5">
            <Label htmlFor="assign-feedback">{t('feedback')}</Label>
            <RichTextEditor
              key={draft?.key ?? 0}
              id="assign-feedback"
              name="feedback"
              defaultValue={draft?.html ?? feedback}
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
            <DateTimeInput id="assign-ext" name="dueAt" defaultValue={dueAt} defaultTime="23:59" />
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

const textToHtml = (text: string) =>
  text
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`,
    )
    .join('');

function AiGradeAssist({
  activityId,
  userId,
  consentRequired,
  notice,
  onApply,
}: {
  activityId: string;
  userId: string;
  consentRequired: boolean;
  notice: string;
  onApply: (s: AiGradeSuggestion) => void;
}) {
  const t = useTranslations('mod.assign.ai');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [criteria, setCriteria] = useState('');
  const [s, setS] = useState<AiGradeSuggestion | null>(null);
  const fail = (r: { code?: string; message?: string }) =>
    toast.error(
      r.code === 'RATE_LIMITED'
        ? t('limit')
        : r.code === 'BAD_REQUEST' && r.message?.includes('declined')
          ? t('refused')
          : (r.message ?? 'Error'),
    );
  if (consentRequired)
    return (
      <Alert variant="info" className="grid gap-2">
        <strong>{t('consentTitle')}</strong>
        {notice ? <p className="whitespace-pre-wrap text-sm">{notice}</p> : null}
        <Button
          size="sm"
          className="w-fit"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await callModuleAction(activityId, 'aiConsent', {});
              if (!r.ok) return void fail(r);
              router.refresh();
            })
          }
        >
          {t('consentAccept')}
        </Button>
      </Alert>
    );
  return (
    <section
      aria-labelledby="ai-assist-title"
      className="grid gap-3 rounded-lg border border-dashed p-3"
    >
      <div>
        <h3 id="ai-assist-title" className="font-medium">
          {t('title')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>
      <Field label={t('criteria')} htmlFor="ai-criteria">
        <Textarea
          id="ai-criteria"
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
          className="min-h-16 text-sm"
        />
      </Field>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="w-fit"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await callModuleAction<AiGradeSuggestion>(activityId, 'aiSuggest', {
              userId,
              criteria,
            });
            if (!r.ok || !r.data) return void fail(r);
            setS(r.data);
          })
        }
      >
        {pending ? t('suggesting') : t('suggest')}
      </Button>
      {s ? (
        <div className="grid gap-2 text-sm" aria-live="polite">
          <p className="font-medium">
            {t('suggested', { grade: s.suggestedGrade, max: s.gradeMax })}{' '}
            <span className="text-muted-foreground">
              · {t('confidence', { value: Math.round(s.confidence * 100) })}
            </span>
          </p>
          <ul className="list-disc pl-5">
            {s.criteria.map((c) => (
              <li key={c.name}>
                <strong>{c.name}</strong> ({Math.round(c.score * 100)}%): {c.comment}
              </li>
            ))}
          </ul>
          <p className="text-xs font-medium">{t('feedbackDraft')}</p>
          <p className="whitespace-pre-wrap rounded-md bg-muted p-2">{s.feedbackDraft}</p>
          {s.unreadFiles.length ? (
            <p className="text-xs text-muted-foreground">
              {t('unreadFiles', { files: s.unreadFiles.join(', ') })}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onApply(s);
                void callModuleAction(activityId, 'aiMark', { id: s.id, status: 'APPLIED' });
                toast.success(t('applied'));
                setS(null);
              }}
            >
              {t('apply')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                void callModuleAction(activityId, 'aiMark', { id: s.id, status: 'DISCARDED' });
                setS(null);
              }}
            >
              {t('discard')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
