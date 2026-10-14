'use client';

import { RichTextEditor } from '@hubium/editor/client';
import { useEditorLabels } from '@hubium/editor/field';
import type { AiGradeSuggestion } from '@hubium/module-sdk';
import { callModuleAction, DateTimeInput } from '@hubium/module-sdk/form';
import {
  type GradeRange,
  guideFillingError,
  guideFromShares,
  guideGrade,
  rubricFillingError,
  rubricFromShares,
  rubricGrade,
} from '@hubium/module-sdk/grading';
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
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState, useTransition } from 'react';
import type { WorkflowState } from '../marking.ts';
import { type FormFill, GuideFill, RubricFill } from './marking.tsx';
import { useAction } from './use-action.ts';

export function SubmissionForm({
  activityId,
  courseId,
  allowText,
  allowFiles,
  maxFiles,
  submitButton,
  text,
  files,
  requireStatement = false,
  teamName = null,
}: {
  activityId: string;
  courseId: string;
  allowText: boolean;
  allowFiles: boolean;
  maxFiles: number;
  submitButton: boolean;
  text: string;
  files: { id: string; name: string; url: string }[];
  /** The student accepts that the work is their own before submitting. */
  requireStatement?: boolean;
  /** Team submissions: the team whose work this is. */
  teamName?: string | null;
}) {
  const t = useTranslations('mod.assign');
  const labels = useEditorLabels();
  const { pending, run } = useAction(activityId);
  const formRef = useRef<HTMLFormElement>(null);
  const [remove, setRemove] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [statement, setStatement] = useState(false);
  void courseId;
  const send = (submit: boolean) => {
    const fd = new FormData(formRef.current!);
    const newFiles = fd
      .getAll('newFiles')
      .filter((f): f is File => f instanceof File && f.size > 0);
    run(
      'saveSubmission',
      {
        text: String(fd.get('text') ?? ''),
        submit,
        removeFiles: [...remove],
        statement: requireStatement && statement,
      },
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
  const statementBox = requireStatement ? (
    <label htmlFor="assign-statement" className="flex items-start gap-2 text-sm">
      <Checkbox
        id="assign-statement"
        className="mt-0.5"
        checked={statement}
        onChange={(e) => setStatement(e.target.checked)}
      />
      {teamName ? t('statementTeam') : t('statement')}
    </label>
  ) : null;
  // submitting needs the statement accepted, when the assignment asks for it
  const blocked = requireStatement && !statement;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{teamName ? t('team.work', { name: teamName }) : t('yourText')}</CardTitle>
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
              {statementBox}
              <div className="flex gap-2">
                <Button type="button" disabled={pending || blocked} onClick={() => send(true)}>
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
                <>
                  {statementBox}
                  <Button type="button" disabled={pending || blocked} onClick={() => send(false)}>
                    {t('submit')}
                  </Button>
                </>
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
  team = null,
  form = null,
  range,
  workflow = null,
  allocation = null,
}: {
  activityId: string;
  courseId: string;
  userId: string;
  /** Team submissions: the student's team, whose members can be graded alike. */
  team?: { name: string; size: number } | null;
  gradeMax: number;
  /** Grades of the scale, worst first, when the assignment is graded on one. */
  scale?: string[] | null;
  grade: number | null;
  feedback: string;
  canReopen: boolean;
  nextUrl: string;
  ai?: { available: boolean; consentRequired: boolean; notice: string };
  /** The rubric or marking guide the grade comes from, with what was filled so far. */
  form?: FormFill | null;
  range: GradeRange;
  /** Marking workflow: the student's stage and the stages the user may set. */
  workflow?: { state: WorkflowState; states: WorkflowState[] } | null;
  /** Marker allocation, for those who allocate. */
  allocation?: { markerId: string | null; markers: { id: string; name: string }[] } | null;
}) {
  const t = useTranslations('mod.assign');
  const labels = useEditorLabels();
  const router = useRouter();
  const { pending, run } = useAction(activityId);
  const formRef = useRef<HTMLFormElement>(null);
  // Applying an AI suggestion remounts the editor with the draft as its initial value.
  const [draft, setDraft] = useState<{ key: number; html: string } | null>(null);
  const [scaleGrade, setScaleGrade] = useState(grade === null ? '' : String(grade));
  const [fill, setFill] = useState<FormFill | null>(form);
  const filled = fill ? Object.keys(fill.filling).length > 0 : false;
  const formError = !fill
    ? null
    : !filled
      ? null
      : fill.method === 'rubric'
        ? rubricFillingError(fill.definition, fill.filling)
        : guideFillingError(fill.definition, fill.filling);
  // the grade the form gives, as the server will store it
  const formGrade =
    fill && filled && !formError
      ? fill.method === 'rubric'
        ? rubricGrade(fill.definition, fill.filling, range)
        : guideGrade(fill.definition, fill.filling, range)
      : null;
  const applySuggestion = (s: AiGradeSuggestion) => {
    // with a form the assistant's judgement of each criterion fills it in
    if (fill)
      setFill(
        fill.method === 'rubric'
          ? { ...fill, filling: rubricFromShares(fill.definition, s.criteria) }
          : { ...fill, filling: guideFromShares(fill.definition, s.criteria) },
      );
    // the assistant grades in points; on a scale take the matching share of its grades
    else if (scale)
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
    if (formError) {
      toast.error(fill?.method === 'rubric' ? t('rubric.incomplete') : t('guide.incomplete'));
      return;
    }
    const state = String(fd.get('workflowState') ?? '');
    const marker = fd.get('allocatedMarkerId');
    run(
      'grade',
      {
        userId,
        grade: fill ? null : raw === '' ? null : Number(raw),
        ...(fill && filled ? { [fill.method]: fill.filling } : {}),
        feedback: String(fd.get('feedback') ?? ''),
        reopen: fd.get('reopen') === 'on',
        applyToTeam: fd.get('applyToTeam') === 'on',
        ...(workflow && state && state !== workflow.state ? { workflowState: state } : {}),
        ...(allocation && marker !== null
          ? { allocatedMarkerId: marker === '' ? null : marker }
          : {}),
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
            byForm={!!fill}
          />
        ) : null}
        <form ref={formRef} className="grid gap-4" onSubmit={(e) => e.preventDefault()}>
          {fill ? (
            <>
              {fill.method === 'rubric' ? (
                <RubricFill
                  rubric={fill.definition}
                  value={fill.filling}
                  onChange={(filling) => setFill({ ...fill, filling })}
                />
              ) : (
                <GuideFill
                  guide={fill.definition}
                  value={fill.filling}
                  onChange={(filling) => setFill({ ...fill, filling })}
                />
              )}
              <p className="text-sm font-medium" aria-live="polite">
                {t('rubric.gives')}:{' '}
                {formGrade === null
                  ? '—'
                  : scale
                    ? (scale[formGrade - 1] ?? '—')
                    : `${formGrade} ${t('outOf', { max: gradeMax })}`}
              </p>
            </>
          ) : scale ? (
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
          {workflow ? (
            <Field label={t('workflow.label')} htmlFor="assign-workflow">
              <Select id="assign-workflow" name="workflowState" defaultValue={workflow.state}>
                {[...new Set([workflow.state, ...workflow.states])].map((s) => (
                  <option key={s} value={s}>
                    {t(`workflow.states.${s}`)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {allocation ? (
            <Field label={t('allocation.marker')} htmlFor="assign-marker">
              <Select
                id="assign-marker"
                name="allocatedMarkerId"
                defaultValue={allocation.markerId ?? ''}
              >
                <option value="">{t('allocation.none')}</option>
                {allocation.markers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {team && team.size > 1 ? (
            <label htmlFor="assign-team" className="flex items-center gap-2 text-sm">
              <Checkbox id="assign-team" name="applyToTeam" defaultChecked />
              {t('team.applyToAll', { name: team.name, n: team.size })}
            </label>
          ) : null}
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
  byForm = false,
}: {
  activityId: string;
  userId: string;
  consentRequired: boolean;
  notice: string;
  onApply: (s: AiGradeSuggestion) => void;
  /** The assistant judges the criteria of the assignment's rubric or marking guide. */
  byForm?: boolean;
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
      {byForm ? (
        <p className="text-xs text-muted-foreground">{t('formCriteria')}</p>
      ) : (
        <Field label={t('criteria')} htmlFor="ai-criteria">
          <Textarea
            id="ai-criteria"
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            className="min-h-16 text-sm"
          />
        </Field>
      )}
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

/** Dates for one student or a group (the teacher's overrides tab). */
export function OverrideForm({
  activityId,
  users,
  groups,
}: {
  activityId: string;
  users: { id: string; name: string }[];
  groups: { id: string; name: string }[];
}) {
  const t = useTranslations('mod.assign');
  const { pending, run } = useAction(activityId);
  const [who, setWho] = useState('');
  // a new form after each save: the date pickers start empty again
  const [round, setRound] = useState(0);
  const save = (form: HTMLFormElement) => {
    const fd = new FormData(form);
    const iso = (k: string) => {
      const v = String(fd.get(k) ?? '');
      return v ? new Date(v).toISOString() : null;
    };
    const [kind, id] = who.split(':');
    run(
      'setOverride',
      {
        ...(kind === 'g' ? { groupId: id } : { userId: id }),
        allowSubmissionsFrom: iso('allowSubmissionsFrom'),
        dueAt: iso('dueAt'),
        cutoffAt: iso('cutoffAt'),
      },
      undefined,
      () => {
        setWho('');
        setRound((r) => r + 1);
      },
      t('overrides.saved'),
    );
  };
  return (
    <form
      key={round}
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save(e.currentTarget);
      }}
    >
      <Field label={t('overrides.who')} htmlFor="ao-who">
        <Select id="ao-who" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">{t('overrides.choose')}</option>
          {groups.map((g) => (
            <option key={g.id} value={`g:${g.id}`}>
              {t('overrides.group', { name: g.name })}
            </option>
          ))}
          {users.map((u) => (
            <option key={u.id} value={`u:${u.id}`}>
              {u.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('openAt')} htmlFor="ao-open">
        <DateTimeInput id="ao-open" name="allowSubmissionsFrom" defaultTime="00:00" />
      </Field>
      <Field label={t('dueAt')} htmlFor="ao-due">
        <DateTimeInput id="ao-due" name="dueAt" defaultTime="23:59" />
      </Field>
      <Field label={t('cutoffAt')} htmlFor="ao-cutoff">
        <DateTimeInput id="ao-cutoff" name="cutoffAt" defaultTime="23:59" />
      </Field>
      <Button type="submit" disabled={pending || !who} className="w-fit">
        {t('overrides.save')}
      </Button>
    </form>
  );
}

/** Raise, lower or remove an override. */
export function OverrideActions({
  activityId,
  id,
  name,
  move,
}: {
  activityId: string;
  id: string;
  name: string;
  /** Group overrides can move up or down in priority. */
  move?: { up: boolean; down: boolean };
}) {
  const t = useTranslations('mod.assign');
  const { pending, run } = useAction(activityId);
  return (
    <span className="inline-flex gap-1">
      {move ? (
        <>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={pending || !move.up}
            aria-label={t('overrides.up', { name })}
            onClick={() => run('moveOverride', { id, direction: 'up' })}
          >
            <ArrowUp />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={pending || !move.down}
            aria-label={t('overrides.down', { name })}
            onClick={() => run('moveOverride', { id, direction: 'down' })}
          >
            <ArrowDown />
          </Button>
        </>
      ) : null}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled={pending}
        aria-label={t('overrides.remove', { name })}
        onClick={() => run('deleteOverride', { id }, undefined, undefined, t('overrides.removed'))}
      >
        <Trash2 />
      </Button>
    </span>
  );
}
