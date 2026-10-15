'use client';

import { EditorField } from '@hubium/editor/field';
import { callModuleAction } from '@hubium/module-sdk/form';
import { Button, Checkbox, Field, Input, Select, Textarea } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState, useTransition } from 'react';
import {
  type Answer,
  defaultStructureJump,
  isQuestion,
  isStructure,
  jumpKeywords,
  type PageType,
  pageTypes,
} from '../engine.ts';

type Row = Omit<Answer, 'id'> & { id?: string; key: number };
type PageRef = { id: string; title: string; type: PageType };
type EditedPage = {
  id: string;
  type: PageType;
  title: string;
  contents: string;
  answers: Answer[];
  options: {
    multiple?: boolean;
    caseSensitive?: boolean;
    horizontal?: boolean;
    inMenu?: boolean;
    pairs?: { left: string; right: string }[];
  };
};

/** Options of a jump select: the keywords, then every page by number and title. */
function JumpSelect({
  id,
  value,
  pages,
  onChange,
  label,
}: {
  id: string;
  value: string;
  pages: PageRef[];
  onChange(v: string): void;
  label: string;
}) {
  const t = useTranslations('mod.lesson');
  return (
    <Field label={label} htmlFor={id}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {jumpKeywords.map((k) => (
          <option key={k} value={k}>
            {t(`jumps.${k}`)}
          </option>
        ))}
        {pages.map((p, i) => (
          <option key={p.id} value={p.id}>
            {`${i + 1}. ${p.title || t(`types.${p.type}`)}`}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function defaultRows(type: PageType, t: (k: string) => string): Omit<Row, 'key'>[] {
  const row = (text: string, jump: string, score = 0) => ({ text, response: '', jump, score });
  switch (type) {
    case 'content':
      return [row(t('defaults.next'), 'next')];
    case 'multichoice':
      return [row('', 'next', 1), row('', 'this')];
    case 'truefalse':
      return [row(t('defaults.true'), 'next', 1), row(t('defaults.false'), 'this')];
    case 'matching':
      return [row('', 'next', 1), row('', 'this')];
    case 'shortanswer':
    case 'numerical':
    case 'essay':
      return [row('', 'next', 1)];
    default:
      return [row('', defaultStructureJump(type))];
  }
}

const growable: PageType[] = ['content', 'multichoice', 'shortanswer', 'numerical'];

export function PageForm({
  activityId,
  courseId,
  base,
  type,
  page,
  afterId,
  pages,
  customScoring,
}: {
  activityId: string;
  courseId: string;
  base: string;
  type: PageType;
  page?: EditedPage;
  afterId: string | null;
  pages: PageRef[];
  customScoring: boolean;
}) {
  const t = useTranslations('mod.lesson');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const keys = useRef(0);
  const keyed = (r: Omit<Row, 'key'>): Row => ({ ...r, key: keys.current++ });
  const [rows, setRows] = useState<Row[]>(() => (page?.answers ?? defaultRows(type, t)).map(keyed));
  const [pairs, setPairs] = useState(() =>
    (
      page?.options.pairs ?? [
        { left: '', right: '' },
        { left: '', right: '' },
      ]
    ).map((p) => ({ ...p, key: keys.current++ })),
  );
  const structure = isStructure(type);
  const question = isQuestion(type);
  const set = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const textLabel =
    type === 'content'
      ? t('edit.buttonText')
      : type === 'shortanswer'
        ? t('edit.pattern')
        : type === 'numerical'
          ? t('edit.number')
          : t('edit.answerText');
  const rowLegend = (i: number) =>
    type === 'content'
      ? t('edit.button', { n: i + 1 })
      : type === 'matching'
        ? i === 0
          ? t('edit.allRight')
          : t('edit.someWrong')
        : type === 'essay' || structure
          ? t('edit.after')
          : t('edit.answer', { n: i + 1 });
  const withText = growable.includes(type) || type === 'truefalse';

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const input = {
          title: String(fd.get('title') ?? ''),
          contents: String(fd.get('contents') ?? ''),
          answers: rows.map(({ key: _k, ...r }) => r),
          options: {
            ...(type === 'multichoice' ? { multiple: fd.get('multiple') === 'on' } : {}),
            ...(type === 'shortanswer' ? { caseSensitive: fd.get('caseSensitive') === 'on' } : {}),
            ...(type === 'content'
              ? { horizontal: fd.get('horizontal') === 'on', inMenu: fd.get('inMenu') === 'on' }
              : {}),
            ...(type === 'matching'
              ? { pairs: pairs.map(({ left, right }) => ({ left, right })) }
              : {}),
          },
        };
        start(async () => {
          const r = page
            ? await callModuleAction(activityId, 'updatePage', { ...input, id: page.id })
            : await callModuleAction(activityId, 'addPage', { ...input, type, afterId });
          if (!r.ok) return void toast.error(r.message ?? 'Error');
          toast.success(t('edit.saved'));
          router.push(`${base}?tab=edit`);
          router.refresh();
        });
      }}
    >
      <Field label={t('edit.title')} htmlFor="lp-title">
        <Input
          id="lp-title"
          name="title"
          required={!structure}
          maxLength={255}
          defaultValue={page?.title}
        />
      </Field>
      {structure ? (
        <p className="text-sm text-muted-foreground">{t(`edit.about.${type}`)}</p>
      ) : (
        <EditorField
          name="contents"
          label={question ? t('edit.question') : t('edit.contents')}
          defaultValue={page?.contents}
          courseId={courseId}
          minHeight={200}
        />
      )}
      {type === 'multichoice' ? (
        <label htmlFor="lp-multiple" className="flex items-center gap-2 text-sm">
          <Checkbox id="lp-multiple" name="multiple" defaultChecked={!!page?.options.multiple} />
          {t('edit.multiple')}
        </label>
      ) : null}
      {type === 'shortanswer' ? (
        <label htmlFor="lp-case" className="flex items-center gap-2 text-sm">
          <Checkbox
            id="lp-case"
            name="caseSensitive"
            defaultChecked={!!page?.options.caseSensitive}
          />
          {t('edit.caseSensitive')}
        </label>
      ) : null}
      {type === 'content' ? (
        <div className="grid gap-2">
          <label htmlFor="lp-horizontal" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="lp-horizontal"
              name="horizontal"
              defaultChecked={!!page?.options.horizontal}
            />
            {t('edit.horizontal')}
          </label>
          <label htmlFor="lp-inMenu" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="lp-inMenu"
              name="inMenu"
              defaultChecked={page ? page.options.inMenu !== false : true}
            />
            {t('edit.inMenu')}
          </label>
        </div>
      ) : null}
      {type === 'matching' ? (
        <fieldset className="grid gap-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium">{t('edit.pairs')}</legend>
          {pairs.map((p, i) => (
            <div key={p.key} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Field label={t('edit.left', { n: i + 1 })} htmlFor={`lp-l-${p.key}`}>
                <Input
                  id={`lp-l-${p.key}`}
                  value={p.left}
                  required
                  maxLength={2000}
                  onChange={(e) =>
                    setPairs((ps) =>
                      ps.map((x) => (x.key === p.key ? { ...x, left: e.target.value } : x)),
                    )
                  }
                />
              </Field>
              <Field label={t('edit.right', { n: i + 1 })} htmlFor={`lp-r-${p.key}`}>
                <Input
                  id={`lp-r-${p.key}`}
                  value={p.right}
                  required
                  maxLength={2000}
                  onChange={(e) =>
                    setPairs((ps) =>
                      ps.map((x) => (x.key === p.key ? { ...x, right: e.target.value } : x)),
                    )
                  }
                />
              </Field>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t('edit.removePair', { n: i + 1 })}
                disabled={pairs.length <= 2}
                onClick={() => setPairs((ps) => ps.filter((x) => x.key !== p.key))}
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-self-start"
            onClick={() => setPairs((ps) => [...ps, { left: '', right: '', key: keys.current++ }])}
          >
            <Plus aria-hidden />
            {t('edit.addPair')}
          </Button>
        </fieldset>
      ) : null}
      {rows.map((r, i) => (
        <fieldset key={r.key} className="grid gap-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium">{rowLegend(i)}</legend>
          {withText ? (
            <Field
              label={textLabel}
              htmlFor={`lp-t-${r.key}`}
              hint={type === 'numerical' ? t('edit.numberHint') : undefined}
            >
              <Input
                id={`lp-t-${r.key}`}
                value={r.text}
                required
                maxLength={2000}
                onChange={(e) => set(r.key, { text: e.target.value })}
              />
            </Field>
          ) : null}
          {question ? (
            <Field label={t('edit.response')} htmlFor={`lp-resp-${r.key}`}>
              <Textarea
                id={`lp-resp-${r.key}`}
                rows={2}
                maxLength={5000}
                value={r.response}
                onChange={(e) => set(r.key, { response: e.target.value })}
              />
            </Field>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <JumpSelect
              id={`lp-j-${r.key}`}
              label={t('edit.jump')}
              value={r.jump}
              pages={pages}
              onChange={(jump) => set(r.key, { jump })}
            />
            {question && customScoring && !(type === 'matching' && i === 1) ? (
              <Field label={t('edit.score')} htmlFor={`lp-s-${r.key}`}>
                <Input
                  id={`lp-s-${r.key}`}
                  type="number"
                  step="any"
                  value={r.score}
                  onChange={(e) => set(r.key, { score: Number(e.target.value) || 0 })}
                />
              </Field>
            ) : null}
          </div>
          {growable.includes(type) && rows.length > (type === 'multichoice' ? 2 : 1) ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-self-start"
              onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
            >
              <Trash2 aria-hidden />
              {t('edit.remove')}
            </Button>
          ) : null}
        </fieldset>
      ))}
      {growable.includes(type) ? (
        <Button
          type="button"
          variant="outline"
          className="justify-self-start"
          onClick={() =>
            setRows((rs) => [
              ...rs,
              keyed({
                text: '',
                response: '',
                jump: type === 'content' ? 'next' : 'this',
                score: 0,
              }),
            ])
          }
        >
          <Plus aria-hidden />
          {type === 'content' ? t('edit.addButton') : t('edit.addAnswer')}
        </Button>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {tc('save')}
        </Button>
        <Button asChild variant="outline">
          <Link href={`${base}?tab=edit`}>{tc('cancel')}</Link>
        </Button>
      </div>
    </form>
  );
}

/** Adds a page of the chosen kind after a page (or first). */
export function AddPage({
  base,
  afterId,
  label,
}: {
  base: string;
  afterId: string | null;
  label: string;
}) {
  const t = useTranslations('mod.lesson');
  const router = useRouter();
  const [type, setType] = useState<PageType>('content');
  const id = `lp-add-${afterId ?? 'first'}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        id={id}
        aria-label={t('edit.pageType')}
        className="w-56"
        value={type}
        onChange={(e) => setType(e.target.value as PageType)}
      >
        {pageTypes.map((k) => (
          <option key={k} value={k}>
            {t(`types.${k}`)}
          </option>
        ))}
      </Select>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          router.push(`${base}?tab=edit&add=${type}${afterId ? `&after=${afterId}` : ''}`)
        }
      >
        <Plus aria-hidden />
        {label}
      </Button>
    </div>
  );
}

export function PageTools({
  activityId,
  base,
  page,
  first,
  last,
}: {
  activityId: string;
  base: string;
  page: { id: string; title: string };
  first: boolean;
  last: boolean;
}) {
  const t = useTranslations('mod.lesson');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (action: string, input: Record<string, unknown>, ok?: string) =>
    start(async () => {
      const r = await callModuleAction(activityId, action, { id: page.id, ...input });
      if (!r.ok) return void toast.error(r.message ?? 'Error');
      if (ok) toast.success(ok);
      router.refresh();
    });
  return (
    <div role="toolbar" aria-label={t('edit.tools', { title: page.title })} className="flex gap-1">
      <Button asChild size="icon" variant="ghost" aria-label={tc('edit')}>
        <Link href={`${base}?tab=edit&page=${page.id}`}>
          <Pencil className="size-4" />
        </Link>
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t('edit.moveUp')}
        disabled={pending || first}
        onClick={() => run('movePage', { direction: 'up' })}
      >
        <ArrowUp className="size-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t('edit.moveDown')}
        disabled={pending || last}
        onClick={() => run('movePage', { direction: 'down' })}
      >
        <ArrowDown className="size-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={tc('delete')}
        disabled={pending}
        onClick={() => {
          if (window.confirm(t('edit.deleteConfirm', { title: page.title })))
            run('deletePage', {}, t('edit.deleted'));
        }}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

export function EssayGrade({
  activityId,
  stepId,
  max,
  score,
  comment,
}: {
  activityId: string;
  stepId: string;
  max: number;
  score: number | null;
  comment: string;
}) {
  const t = useTranslations('mod.lesson');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <form
      className="grid gap-3 sm:grid-cols-[8rem_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start(async () => {
          const r = await callModuleAction(activityId, 'gradeEssay', {
            stepId,
            score: Number(fd.get('score')),
            comment: String(fd.get('comment') ?? ''),
          });
          if (!r.ok) return void toast.error(r.message ?? 'Error');
          toast.success(t('essays.saved'));
          router.refresh();
        });
      }}
    >
      <Field label={t('essays.score', { max })} htmlFor={`es-${stepId}`}>
        <Input
          id={`es-${stepId}`}
          name="score"
          type="number"
          min={0}
          max={max}
          step="any"
          required
          defaultValue={score ?? ''}
        />
      </Field>
      <Field label={t('essays.comment')} htmlFor={`ec-${stepId}`}>
        <Input id={`ec-${stepId}`} name="comment" maxLength={10_000} defaultValue={comment} />
      </Field>
      <Button type="submit" disabled={pending}>
        {tc('save')}
      </Button>
    </form>
  );
}

export function DeleteAttempt({
  activityId,
  attemptId,
}: {
  activityId: string;
  attemptId: string;
}) {
  const t = useTranslations('mod.lesson');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (!window.confirm(t('reports.deleteConfirm'))) return;
        start(async () => {
          const r = await callModuleAction(activityId, 'deleteAttempt', { attemptId });
          if (!r.ok) return void toast.error(r.message ?? 'Error');
          toast.success(t('reports.deleted'));
          router.refresh();
        });
      }}
    >
      <Trash2 aria-hidden />
      {t('reports.delete')}
    </Button>
  );
}
