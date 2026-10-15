'use client';

import {
  Alert,
  Button,
  Checkbox,
  Combobox,
  type ComboboxOption,
  Select,
  Textarea,
} from '@hubium/ui';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@hubium/ui/dialog';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from 'react';
import { bulkTargetsAction, bulkUsersAction } from '@/server/actions/admin';

// Selecting people in Administration → Users and acting on them together.

interface Filter {
  q?: string;
  status?: 'ACTIVE' | 'SUSPENDED';
}

const Ctx = createContext<{
  selected: Set<string>;
  toggle: (id: string, on: boolean) => void;
} | null>(null);

const ACTIONS = [
  'suspend',
  'activate',
  'forcePasswordChange',
  'unlock',
  'addToCohort',
  'enrol',
  'message',
  'delete',
] as const;
type Kind = (typeof ACTIONS)[number];

export function BulkUsers({
  children,
  pageIds,
  total,
  filter,
  roles,
  canDelete,
}: {
  children: ReactNode;
  pageIds: string[];
  total: number;
  filter: Filter;
  roles: { id: string; name: string }[];
  canDelete: boolean;
}) {
  const t = useTranslations('admin.bulk');
  const tc = useTranslations('common');
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [everyone, setEveryone] = useState(false);
  const [kind, setKind] = useState<Kind>('suspend');
  const [cohortId, setCohortId] = useState('');
  const [courseId, setCourseId] = useState('');
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const [body, setBody] = useState('');
  const [result, setResult] = useState<{
    done: number;
    total: number;
    failed: { name: string; error: string }[];
  } | null>(null);
  const [pending, start] = useTransition();
  const ctx = useMemo(
    () => ({
      selected,
      toggle: (id: string, on: boolean) => {
        setEveryone(false);
        setSelected((s) => {
          const next = new Set(s);
          if (on) next.add(id);
          else next.delete(id);
          return next;
        });
      },
    }),
    [selected],
  );
  const count = everyone ? total : selected.size;
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selection = everyone ? { filter } : { ids: [...selected] };
  const exportHref = (format: string) => {
    const p = new URLSearchParams({ format });
    if (everyone) {
      if (filter.q) p.set('q', filter.q);
      if (filter.status) p.set('status', filter.status);
      p.set('all', '1');
    } else p.set('ids', [...selected].join(','));
    return `/admin/users/export?${p}`;
  };

  function run() {
    const action =
      kind === 'addToCohort'
        ? { kind, cohortId }
        : kind === 'enrol'
          ? { kind, courseId, roleId }
          : kind === 'message'
            ? { kind, body }
            : { kind };
    start(async () => {
      const r = await bulkUsersAction(selection, action);
      if (!r.ok) return void toast.error(r.message);
      if (r.data.queued) {
        toast.success(t('queued', { count: r.data.total }));
        setResult(null);
      } else {
        setResult(r.data.result);
        if (!r.data.result.failed.length) toast.success(t('done', { count: r.data.result.done }));
      }
      setSelected(new Set());
      setEveryone(false);
      router.refresh();
    });
  }

  const ready =
    count > 0 &&
    (kind !== 'addToCohort' || cohortId) &&
    (kind !== 'enrol' || (courseId && roleId)) &&
    (kind !== 'message' || body.trim());

  return (
    <Ctx.Provider value={ctx}>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <label htmlFor="bulk-page" className="flex items-center gap-2">
          <Checkbox
            id="bulk-page"
            checked={allOnPage}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              setEveryone(false);
              setSelected((s) => {
                const next = new Set(s);
                for (const id of pageIds) {
                  if (on) next.add(id);
                  else next.delete(id);
                }
                return next;
              });
            }}
          />
          {t('selectPage')}
        </label>
        {total > pageIds.length ? (
          <label htmlFor="bulk-all" className="flex items-center gap-2">
            <Checkbox
              id="bulk-all"
              checked={everyone}
              onChange={(e) => setEveryone(e.currentTarget.checked)}
            />
            {t('selectAll', { count: total })}
          </label>
        ) : null}
      </div>
      {children}
      {count ? (
        <section
          aria-label={t('title')}
          className="sticky bottom-16 z-10 mt-4 grid gap-3 rounded-lg border border-border bg-card p-3 shadow-md md:bottom-4"
        >
          <p className="text-sm font-medium" role="status">
            {t('selected', { count })}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid min-w-48 gap-1">
              <label htmlFor="bulk-action" className="text-sm">
                {t('action')}
              </label>
              <Select
                id="bulk-action"
                value={kind}
                onChange={(e) => setKind(e.currentTarget.value as Kind)}
              >
                {ACTIONS.filter((a) => a !== 'delete' || canDelete).map((a) => (
                  <option key={a} value={a}>
                    {t(`actions.${a}`)}
                  </option>
                ))}
              </Select>
            </div>
            {kind === 'addToCohort' ? (
              <div className="grid min-w-48 gap-1">
                <label htmlFor="bulk-cohort" className="text-sm">
                  {t('cohort')}
                </label>
                <TargetPick
                  id="bulk-cohort"
                  kind="cohort"
                  value={cohortId}
                  onChange={setCohortId}
                />
              </div>
            ) : null}
            {kind === 'enrol' ? (
              <>
                <div className="grid min-w-56 gap-1">
                  <label htmlFor="bulk-course" className="text-sm">
                    {t('course')}
                  </label>
                  <TargetPick
                    id="bulk-course"
                    kind="course"
                    value={courseId}
                    onChange={setCourseId}
                  />
                </div>
                <div className="grid min-w-40 gap-1">
                  <label htmlFor="bulk-role" className="text-sm">
                    {t('role')}
                  </label>
                  <Select
                    id="bulk-role"
                    value={roleId}
                    onChange={(e) => setRoleId(e.currentTarget.value)}
                  >
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </>
            ) : null}
            {kind === 'delete' ? (
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="destructive" disabled={!ready || pending}>
                    {t('apply')}
                  </Button>
                </DialogTrigger>
                <DialogContent title={t('deleteTitle')}>
                  <p className="text-sm">{t('deleteConfirm', { count })}</p>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="outline">{tc('cancel')}</Button>
                    </DialogClose>
                    <DialogClose asChild>
                      <Button variant="destructive" onClick={run}>
                        {t('actions.delete')}
                      </Button>
                    </DialogClose>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            ) : (
              <Button disabled={!ready || pending} onClick={run}>
                {t('apply')}
              </Button>
            )}
          </div>
          {kind === 'message' ? (
            <div className="grid gap-1">
              <label htmlFor="bulk-message" className="text-sm">
                {t('message')}
              </label>
              <Textarea
                id="bulk-message"
                rows={3}
                value={body}
                onChange={(e) => setBody(e.currentTarget.value)}
              />
            </div>
          ) : null}
          <p className="flex flex-wrap gap-3 text-sm">
            {t('export')}:
            {(['csv', 'xlsx', 'ods'] as const).map((f) => (
              <a key={f} href={exportHref(f)} className="text-accent hover:underline">
                {f.toUpperCase()}
              </a>
            ))}
          </p>
        </section>
      ) : null}
      {result ? (
        <Alert variant={result.failed.length ? 'warning' : 'success'} className="mt-4 grid gap-1">
          <strong>{t('result', { done: result.done, total: result.total })}</strong>
          {result.failed.map((f) => (
            <span key={f.name} className="text-sm">
              {f.name}: {f.error}
            </span>
          ))}
        </Alert>
      ) : null}
    </Ctx.Provider>
  );
}

/** A course or cohort, found on the server as the search is typed. */
function TargetPick({
  id,
  kind,
  value,
  onChange,
}: {
  id: string;
  kind: 'course' | 'cohort';
  value: string;
  onChange: (value: string) => void;
}) {
  const tc = useTranslations('common');
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<ComboboxOption[]>([]);
  useEffect(() => {
    // an answer to an earlier search that arrives late is not shown
    let current = true;
    const h = setTimeout(
      async () => {
        const r = await bulkTargetsAction(kind, q).catch(() => null);
        if (current && r?.ok) setOptions(r.data);
      },
      q ? 250 : 0,
    );
    return () => {
      current = false;
      clearTimeout(h);
    };
  }, [kind, q]);
  return (
    <Combobox
      id={id}
      options={options}
      value={value}
      onChange={onChange}
      onSearch={setQ}
      placeholder={tc('select')}
    />
  );
}

/** The row checkbox. */
export function RowCheck({ id, name }: { id: string; name: string }) {
  const ctx = useContext(Ctx);
  const t = useTranslations('admin.bulk');
  if (!ctx) return null;
  return (
    <Checkbox
      aria-label={t('selectOne', { name })}
      checked={ctx.selected.has(id)}
      onChange={(e) => ctx.toggle(id, e.currentTarget.checked)}
    />
  );
}
