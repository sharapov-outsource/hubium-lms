'use client';

import type { ImportPlan } from '@hubium/core/groups/import';
import type { ActionResult } from '@hubium/core/operation';
import { Alert, Button } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';

/** A CSV file checked first (what would change, problems by line), then imported. */
export function CsvImport({
  run,
  sample,
}: {
  run: (csv: string, apply: boolean) => Promise<ActionResult<ImportPlan>>;
  /** The expected columns, shown as an example. */
  sample: string;
}) {
  const t = useTranslations('csvImport');
  const id = useId();
  const router = useRouter();
  const [csv, setCsv] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [pending, start] = useTransition();
  const go = (apply: boolean) =>
    start(async () => {
      if (!csv) return;
      const r = await run(csv, apply);
      if (!r.ok) return void toast.error(r.message);
      setPlan(r.data);
      if (apply) {
        toast.success(t('done'));
        setCsv(null);
        router.refresh();
      }
    });
  const failed = plan?.lines.filter((l) => l.error) ?? [];
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">{t('hint')}</p>
      <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{sample}</pre>
      <label htmlFor={id} className="text-sm font-medium">
        {t('file')}
      </label>
      <input
        id={id}
        type="file"
        accept=".csv,text/csv"
        className="text-sm"
        onChange={async (e) => {
          const f = e.currentTarget.files?.[0];
          setPlan(null);
          setCsv(f ? await f.text() : null);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!csv || pending} onClick={() => go(false)}>
          {t('check')}
        </Button>
        <Button disabled={!csv || pending || !plan || plan.applied} onClick={() => go(true)}>
          {t('import')}
        </Button>
      </div>
      {plan ? (
        <Alert variant={failed.length ? 'warning' : 'success'} className="grid gap-1">
          <strong>{plan.applied ? t('applied') : t('preview')}</strong>
          {plan.created.length ? (
            <span className="text-sm">{t('created', { names: plan.created.join(', ') })}</span>
          ) : null}
          {plan.createdGroupings.length ? (
            <span className="text-sm">
              {t('createdGroupings', { names: plan.createdGroupings.join(', ') })}
            </span>
          ) : null}
          <span className="text-sm">{t('memberships', { count: plan.memberships })}</span>
        </Alert>
      ) : null}
      {failed.length ? (
        <ul className="grid gap-1 text-sm" aria-label={t('problems')}>
          {failed.map((l) => (
            <li key={l.line} className="break-words">
              {t('lineProblem', { line: l.line, target: l.target || '—', user: l.user || '—' })}:{' '}
              <span className="text-destructive">{l.error}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
