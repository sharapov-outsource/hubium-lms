'use client';

import { Badge, Select } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { setRoleCapabilityAction, setRoleOverrideAction } from '@/server/actions/admin';

type Perm = 'ALLOW' | 'DENY' | 'PROHIBIT' | 'INHERIT';

/** What the matrix edits: a role's own definition, or its overrides in one context. */
export type MatrixTarget =
  | { kind: 'role'; roleId: string }
  | { kind: 'override'; roleId: string; contextId: string };

export function CapabilityMatrix({
  target,
  groups,
  current,
  defaults,
  readOnly = false,
}: {
  target: MatrixTarget;
  groups: [string, { cap: string; risk: string[] }[]][];
  current: Record<string, string>;
  /** The role's own value per capability, shown next to each override. */
  defaults?: Record<string, string>;
  readOnly?: boolean;
}) {
  const t = useTranslations('admin.role');
  const tp = useTranslations('permissions');
  const tc = useTranslations('common');
  const [values, setValues] = useState<Record<string, string>>(current);
  const [filter, setFilter] = useState('');
  const [, start] = useTransition();
  const options: Perm[] =
    target.kind === 'role'
      ? ['INHERIT', 'ALLOW', 'PROHIBIT']
      : ['INHERIT', 'ALLOW', 'DENY', 'PROHIBIT'];
  const label = (p: Perm) =>
    p === 'INHERIT'
      ? target.kind === 'role'
        ? t('inherit')
        : tp('inherit')
      : t(p.toLowerCase() as 'allow' | 'deny' | 'prohibit');

  function change(cap: string, perm: Perm) {
    const prev = values[cap];
    setValues((v) => ({ ...v, [cap]: perm }));
    start(async () => {
      const r =
        target.kind === 'role'
          ? await setRoleCapabilityAction(target.roleId, cap, perm as 'ALLOW')
          : await setRoleOverrideAction(target.contextId, target.roleId, cap, perm);
      if (r.ok) toast.success(tc('saved'));
      else {
        toast.error(r.message);
        setValues((v) => ({ ...v, [cap]: prev ?? 'INHERIT' }));
      }
    });
  }

  return (
    <div className="grid gap-4">
      <label htmlFor="cap-filter" className="sr-only">
        {tc('search')}
      </label>
      <input
        id="cap-filter"
        className="h-9 max-w-xs rounded-md border border-input bg-background px-3 text-sm"
        placeholder={tc('searchPlaceholder')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {groups.map(([group, caps]) => {
        const visible = caps.filter((c) => c.cap.includes(filter.trim()));
        if (!visible.length) return null;
        return (
          <section key={group}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group}
            </h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {visible.map(({ cap, risk }) => {
                const v = (values[cap] ?? 'INHERIT') as Perm;
                const base = defaults ? (defaults[cap] as Perm | undefined) : undefined;
                return (
                  <li
                    key={cap}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <code className="font-mono text-sm">{cap}</code>
                      {risk.map((r) => (
                        <Badge key={r} variant="warning">
                          {t(`risks.${r as 'config'}`)}
                        </Badge>
                      ))}
                      {defaults ? (
                        <span className="text-xs text-muted-foreground">
                          {tp('roleDefault', { value: base ? label(base) : tp('notSet') })}
                        </span>
                      ) : null}
                    </span>
                    <Select
                      aria-label={cap}
                      className="h-8 w-44"
                      value={v}
                      disabled={readOnly}
                      onChange={(e) => change(cap, e.target.value as Perm)}
                    >
                      {options.map((p) => (
                        <option key={p} value={p}>
                          {label(p)}
                        </option>
                      ))}
                    </Select>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
