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
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { ModuleIcon } from '@/components/module-icon';
import {
  activityCommandAction,
  addSectionAction,
  moveActivityToSectionAction,
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
  labels: { mark: string; done: string; auto: string };
}) {
  const { pending, run } = useRun();
  const done = state !== 'INCOMPLETE';
  if (!manual) {
    return (
      <span
        title={labels.auto}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${done ? 'bg-success-soft text-success' : 'bg-muted text-muted-foreground'}`}
      >
        {done ? <Check className="size-3" aria-hidden /> : null}
        {done ? labels.done : labels.auto}
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
  sections,
}: {
  courseId: string;
  activity: { id: string; name: string; visibility: string };
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
          <DropdownMenuItem asChild>
            <Link
              href={`/course/${courseId}/a/${activity.id}/edit?returnTo=${encodeURIComponent(`/course/${courseId}?edit=1`)}`}
            >
              <Pencil />
              {tc('edit')}
            </Link>
          </DropdownMenuItem>
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
          <DropdownMenuItem
            onSelect={() => run(() => activityCommandAction(courseId, activity.id, 'duplicate'))}
          >
            <Copy />
            {t('duplicate')}
          </DropdownMenuItem>
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

export function SectionMenu({
  courseId,
  section,
}: {
  courseId: string;
  section: { id: string; title: string; summary: string; visible: boolean; isFirst: boolean };
}) {
  const t = useTranslations('course');
  const tc = useTranslations('common');
  const { pending, run } = useRun();
  const [editOpen, setEditOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`${tc('actions')}: ${section.title || t('editSection')}`}
            disabled={pending}
          >
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>
            <Pencil />
            {t('editSection')}
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
                {t('deleteSection')}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent title={t('editSection')} closeLabel={tc('close')} className="max-w-2xl">
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
              <Label htmlFor={`st-${section.id}`}>{t('sectionTitle')}</Label>
              <Input id={`st-${section.id}`} name="title" defaultValue={section.title} />
            </div>
            <EditorField
              name="summary"
              label={t('sectionSummary')}
              defaultValue={section.summary}
              courseId={courseId}
              minHeight={100}
            />
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
