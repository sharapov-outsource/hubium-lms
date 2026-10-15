'use client';

import { EditorField } from '@hubium/editor/field';
import { Button, Input, Label, Select } from '@hubium/ui';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@hubium/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@hubium/ui/dropdown';
import { toast } from '@hubium/ui/theme';
import {
  Check,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FolderInput,
  MoreVertical,
  MoveDown,
  MoveUp,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import { ActionForm, SubmitButton } from '@/components/action-form';
import {
  AvailabilityEditor,
  type AvailabilityOptions,
  type AvailabilityValue,
} from '@/components/availability-editor';
import { ModuleIcon } from '@/components/module-icon';
import {
  activityCommandAction,
  addSectionAction,
  moveActivityToSectionAction,
  moveSubsectionAction,
  sectionCommandAction,
  toggleCompletionAction,
  updateSectionAction,
} from '@/server/actions/courses';

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message?: string } | undefined>) =>
    start(async () => {
      const r = await fn();
      if (r && !r.ok) toast.error(r.message ?? 'Error');
      router.refresh();
    });
  return { pending, run };
}

export function CompletionToggle({
  courseId,
  activityId,
  manual,
  state,
  labels,
}: {
  courseId: string;
  activityId: string;
  manual: boolean;
  state: string;
  labels: { mark: string; done: string; auto: string; failed: string };
}) {
  const { pending, run } = useRun();
  // a failed activity (a pass mark not reached) is not done
  const done = state === 'COMPLETE' || state === 'COMPLETE_PASS';
  const failed = state === 'COMPLETE_FAIL';
  if (!manual) {
    return (
      <span
        title={labels.auto}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${done ? 'bg-success-soft text-success' : failed ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}
      >
        {done ? <Check className="size-3" aria-hidden /> : null}
        {failed ? <X className="size-3" aria-hidden /> : null}
        {done ? labels.done : failed ? labels.failed : labels.auto}
      </span>
    );
  }
  return (
    <Button
      size="sm"
      variant={done ? 'secondary' : 'outline'}
      aria-pressed={done}
      disabled={pending}
      onClick={() => run(() => toggleCompletionAction(courseId, activityId, !done))}
      className={done ? 'text-success' : undefined}
    >
      {done ? <Check /> : null}
      {done ? labels.done : labels.mark}
    </Button>
  );
}

export function ActivityMenu({
  courseId,
  activity,
  dependents = [],
  sections,
}: {
  courseId: string;
  /** `disabled`: its type is turned off, so it can be moved and deleted but not edited. */
  activity: { id: string; name: string; visibility: string; disabled?: boolean };
  /** Activities and sections whose restrictions name this one. */
  dependents?: string[];
  sections: { id: string; title: string }[];
}) {
  const t = useTranslations('course');
  const tc = useTranslations('common');
  const { pending, run } = useRun();
  const [moveOpen, setMoveOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [target, setTarget] = useState(sections[0]?.id ?? '');
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`${tc('actions')}: ${activity.name}`}
            disabled={pending}
          >
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {activity.disabled ? null : (
            <DropdownMenuItem asChild>
              <Link
                href={`/course/${courseId}/a/${activity.id}/edit?returnTo=${encodeURIComponent(`/course/${courseId}?edit=1`)}`}
              >
                <Pencil />
                {tc('edit')}
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => run(() => activityCommandAction(courseId, activity.id, 'up'))}
          >
            <MoveUp />
            {t('moveUp')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => run(() => activityCommandAction(courseId, activity.id, 'down'))}
          >
            <MoveDown />
            {t('moveDown')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setMoveOpen(true)}>
            <FolderInput />
            {t('moveTo')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {activity.visibility === 'SHOWN' ? (
            <DropdownMenuItem
              onSelect={() => run(() => activityCommandAction(courseId, activity.id, 'hide'))}
            >
              <EyeOff />
              {t('hide')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onSelect={() => run(() => activityCommandAction(courseId, activity.id, 'show'))}
            >
              <Eye />
              {t('show')}
            </DropdownMenuItem>
          )}
          {activity.disabled ? null : (
            <DropdownMenuItem
              onSelect={() => run(() => activityCommandAction(courseId, activity.id, 'duplicate'))}
            >
              <Copy />
              {t('duplicate')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setDelOpen(true)} className="text-destructive">
            <Trash2 />
            {t('delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent title={t('moveTo')} description={activity.name} closeLabel={tc('close')}>
          <Label htmlFor={`mv-${activity.id}`}>{t('moveTo')}</Label>
          <Select
            id={`mv-${activity.id}`}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </Select>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{tc('cancel')}</Button>
            </DialogClose>
            <Button
              disabled={pending}
              onClick={() => {
                setMoveOpen(false);
                run(() => moveActivityToSectionAction(courseId, activity.id, target));
              }}
            >
              {tc('apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={delOpen} onOpenChange={setDelOpen}>
        <DialogContent
          title={t('delete')}
          description={t('deleteConfirm', { name: activity.name })}
          closeLabel={tc('close')}
        >
          {dependents.length ? (
            <p className="text-sm text-warning">
              {t('deleteDependents', { names: dependents.join(', ') })}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{tc('cancel')}</Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                setDelOpen(false);
                run(() => activityCommandAction(courseId, activity.id, 'delete'));
              }}
            >
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * A section's menu; a subsection's (with `parentId`) also moves it to another of
 * `sections`, the course's sections.
 */
export function SectionMenu({
  courseId,
  section,
  sections = [],
  restrictions,
}: {
  courseId: string;
  section: {
    id: string;
    title: string;
    summary: string;
    visible: boolean;
    isFirst: boolean;
    parentId?: string | null;
    availability?: AvailabilityValue | null;
  };
  sections?: { id: string; title: string }[];
  /** What access conditions can name; without it the dialog leaves them as they are. */
  restrictions?: AvailabilityOptions;
}) {
  const t = useTranslations('course');
  const ta = useTranslations('activity');
  const tc = useTranslations('common');
  const { pending, run } = useRun();
  const [editOpen, setEditOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const sub = !!section.parentId;
  const targets = sections.filter((s) => s.id !== section.parentId);
  const [target, setTarget] = useState(targets[0]?.id ?? '');
  const router = useRouter();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`${tc('actions')}: ${section.title || t(sub ? 'editSubsection' : 'editSection')}`}
            disabled={pending}
          >
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>
            <Pencil />
            {t(sub ? 'editSubsection' : 'editSection')}
          </DropdownMenuItem>
          {!section.isFirst ? (
            <>
              <DropdownMenuItem
                onSelect={() => run(() => sectionCommandAction(courseId, section.id, 'up'))}
              >
                <MoveUp />
                {t('moveUp')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => run(() => sectionCommandAction(courseId, section.id, 'down'))}
              >
                <MoveDown />
                {t('moveDown')}
              </DropdownMenuItem>
              {sub && targets.length ? (
                <DropdownMenuItem onSelect={() => setMoveOpen(true)}>
                  <FolderInput />
                  {t('moveTo')}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                onSelect={() =>
                  run(() =>
                    sectionCommandAction(courseId, section.id, section.visible ? 'hide' : 'show'),
                  )
                }
              >
                {section.visible ? <EyeOff /> : <Eye />}
                {section.visible ? t('hide') : t('show')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onSelect={() => run(() => sectionCommandAction(courseId, section.id, 'delete'))}
              >
                <Trash2 />
                {t(sub ? 'deleteSubsection' : 'deleteSection')}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {sub ? (
        <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
          <DialogContent title={t('moveTo')} description={section.title} closeLabel={tc('close')}>
            <Label htmlFor={`smv-${section.id}`}>{t('moveTo')}</Label>
            <Select
              id={`smv-${section.id}`}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {targets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </Select>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">{tc('cancel')}</Button>
              </DialogClose>
              <Button
                disabled={pending}
                onClick={() => {
                  setMoveOpen(false);
                  run(() => moveSubsectionAction(courseId, section.id, target));
                }}
              >
                {tc('apply')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent
          title={t(sub ? 'editSubsection' : 'editSection')}
          closeLabel={tc('close')}
          className="max-w-2xl"
        >
          <ActionForm
            action={updateSectionAction}
            success={tc('saved')}
            className="grid gap-4"
            onSuccess={() => {
              setEditOpen(false);
              router.refresh();
            }}
          >
            <input type="hidden" name="id" value={section.id} />
            <input type="hidden" name="courseId" value={courseId} />
            <div className="grid content-start gap-1.5">
              <Label htmlFor={`st-${section.id}`}>
                {t(sub ? 'subsectionTitle' : 'sectionTitle')}
              </Label>
              <Input id={`st-${section.id}`} name="title" defaultValue={section.title} />
            </div>
            <EditorField
              name="summary"
              label={t(sub ? 'subsectionSummary' : 'sectionSummary')}
              defaultValue={section.summary}
              courseId={courseId}
              minHeight={100}
            />
            {restrictions ? (
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">{ta('access')}</legend>
                <AvailabilityEditor initial={section.availability} {...restrictions} />
              </fieldset>
            ) : null}
            <DialogFooter>
              <SubmitButton>{tc('save')}</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AddActivityButton({
  courseId,
  sectionId,
  modules,
}: {
  courseId: string;
  sectionId: string;
  modules: { key: string; icon: string; archetype: string; name: string; description: string }[];
}) {
  const t = useTranslations('course');
  const tc = useTranslations('common');
  const groups = [
    { label: t('activities'), items: modules.filter((m) => m.archetype === 'activity') },
    { label: t('resources'), items: modules.filter((m) => m.archetype !== 'activity') },
  ].filter((g) => g.items.length);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus />
          {t('addActivity')}
        </Button>
      </DialogTrigger>
      <DialogContent title={t('chooseActivity')} closeLabel={tc('close')} className="max-w-2xl">
        {groups.map((g) => (
          <section key={g.label} className="grid gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {g.label}
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {g.items.map((m) => (
                <Link
                  key={m.key}
                  href={`/course/${courseId}/a/new?module=${m.key}&section=${sectionId}`}
                  className="flex items-start gap-3 rounded-lg border border-border p-3 hover:border-accent hover:bg-accent-soft/50"
                >
                  <ModuleIcon icon={m.icon} archetype={m.archetype} />
                  <span>
                    <span className="block font-medium">{m.name}</span>
                    <span className="block text-xs text-muted-foreground">{m.description}</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}

export function AddSectionButton({ courseId }: { courseId: string }) {
  const t = useTranslations('course');
  const { pending, run } = useRun();
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={() => run(() => addSectionAction(courseId))}
    >
      <Plus />
      {t('addSection')}
    </Button>
  );
}

export function AddSubsectionButton({
  courseId,
  parentId,
}: {
  courseId: string;
  parentId: string;
}) {
  const t = useTranslations('course');
  const { pending, run } = useRun();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() => run(() => addSectionAction(courseId, { parentId, title: t('newSubsection') }))}
    >
      <Plus />
      {t('addSubsection')}
    </Button>
  );
}

/**
 * A subsection on the course page: collapsible, and remembered collapsed in this browser.
 * The menu stays outside the toggle (a button may not hold another).
 */
export function SubsectionBlock({
  id,
  title,
  badges,
  menu,
  children,
}: {
  id: string;
  title: string;
  badges?: React.ReactNode;
  menu?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const key = `hubium:subsection:${id}`;
  useEffect(() => {
    try {
      if (localStorage.getItem(key) === 'closed') setOpen(false);
    } catch {}
  }, [key]);
  const toggle = () =>
    setOpen((was) => {
      try {
        if (was) localStorage.setItem(key, 'closed');
        else localStorage.removeItem(key);
      } catch {}
      return !was;
    });
  return (
    <section aria-labelledby={`sub-${id}`} className="rounded-lg border border-border">
      <div className="flex items-center gap-2 px-3 py-2">
        <h3 id={`sub-${id}`} className="min-w-0 flex-1 font-semibold">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`sub-body-${id}`}
            onClick={toggle}
            className="flex w-full items-center gap-2 rounded-sm text-left"
          >
            <ChevronRight
              className={`size-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
              aria-hidden
            />
            <span className="min-w-0 break-words">{title}</span>
          </button>
        </h3>
        {badges}
        {menu}
      </div>
      <div id={`sub-body-${id}`} hidden={!open} className="border-t border-border">
        {children}
      </div>
    </section>
  );
}
