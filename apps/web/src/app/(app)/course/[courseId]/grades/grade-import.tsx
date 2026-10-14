'use client';

import { Alert, Button, Field, Input, Select, Table, TBody, Td, THead, Th, Tr } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { applyGradeImportAction, previewGradeImportAction } from '@/server/actions/grades';

type Problem = { code: 'noKey' | 'noStudent' | 'notAGrade'; item?: string; value: string };

interface Mapping {
  userColumn: number;
  userField: 'email' | 'username';
  columns: { column: number; itemId: string; what: 'grade' | 'feedback' }[];
}

type Preview = {
  header: string[];
  sample: string[];
  mapping: Mapping;
  items: { id: string; name: string; kind: string }[];
  rows: {
    line: number;
    key: string;
    user: { id: string; name: string } | null;
    changes: { itemId: string; grade?: number; feedback?: string }[];
    problems: Problem[];
  }[];
  problems: { line: number; problems: Problem[] }[];
  totals: { students: number; grades: number; errors: number };
};

/** What a column holds, as the mapping select names it. */
const roleOf = (m: Mapping, column: number) => {
  if (m.userColumn === column) return `user:${m.userField}`;
  const c = m.columns.find((x) => x.column === column);
  return c ? `${c.what}:${c.itemId}` : '';
};

function withRole(m: Mapping, column: number, role: string): Mapping {
  const columns = m.columns.filter((x) => x.column !== column);
  if (role.startsWith('user:'))
    return {
      userColumn: column,
      userField: role.slice(5) as Mapping['userField'],
      columns,
    };
  const [what, itemId] = role.split(':') as ['grade' | 'feedback', string];
  return {
    ...m,
    // a column cannot both find students and hold grades
    userColumn: m.userColumn === column ? -1 : m.userColumn,
    columns: role
      ? [
          ...columns.filter((x) => !(x.itemId === itemId && x.what === what)),
          { column, itemId, what },
        ]
      : columns,
  };
}

/**
 * Grades from a spreadsheet in two steps: the file is read and its columns mapped (guessed
 * from the header, changed here), with what would happen shown for the first rows; then
 * applied. The file goes again with each step, nothing is kept in between.
 */
export function GradeImport({ courseId }: { courseId: string }) {
  const t = useTranslations('grades.importFlow');
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [pending, start] = useTransition();
  const form = (m?: Mapping) => {
    const fd = new FormData();
    fd.set('courseId', courseId);
    if (file) fd.set('file', file);
    if (m) fd.set('mapping', JSON.stringify(m));
    return fd;
  };
  const show = (m?: Mapping) =>
    start(async () => {
      const r = await previewGradeImportAction(form(m));
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setPreview(r.data as Preview);
      setMapping((r.data as Preview).mapping);
    });
  const apply = () =>
    start(async () => {
      if (!mapping) return;
      const r = await applyGradeImportAction(form(mapping));
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(t('applied', { n: r.data.updated, errors: r.data.errors.length }));
      setPreview(null);
      setMapping(null);
      setFile(null);
      router.refresh();
    });
  const itemName = (id: string) => preview?.items.find((i) => i.id === id)?.name ?? '?';
  const say = (ps: Problem[]) =>
    ps.map((p) => t(`problem.${p.code}`, { item: p.item ?? '', value: p.value })).join('; ');
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('hint')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('file')} htmlFor="grade-import-file">
          <Input
            id="grade-import-file"
            type="file"
            accept=".csv,.xlsx,.ods,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.oasis.opendocument.spreadsheet"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
              setMapping(null);
            }}
          />
        </Field>
        <Button
          type="button"
          variant="secondary"
          disabled={!file || pending}
          onClick={() => show()}
        >
          {t('preview')}
        </Button>
      </div>
      {preview && mapping ? (
        <>
          <section aria-labelledby="grade-import-mapping" className="grid gap-2">
            <h4 id="grade-import-mapping" className="text-sm font-medium">
              {t('mapping')}
            </h4>
            <Table>
              <THead>
                <Tr>
                  <Th>{t('column')}</Th>
                  <Th>{t('sample')}</Th>
                  <Th>{t('as')}</Th>
                </Tr>
              </THead>
              <TBody>
                {preview.header.map((h, i) => (
                  // a sheet's columns are their positions
                  // biome-ignore lint/suspicious/noArrayIndexKey: the column number is its identity
                  <Tr key={i}>
                    <Td className="font-medium">{h || `#${i + 1}`}</Td>
                    <Td className="max-w-48 truncate text-sm text-muted-foreground">
                      {preview.sample[i] ?? ''}
                    </Td>
                    <Td>
                      <Select
                        aria-label={`${t('as')}: ${h || `#${i + 1}`}`}
                        className="h-8 w-64"
                        value={roleOf(mapping, i)}
                        onChange={(e) => setMapping(withRole(mapping, i, e.target.value))}
                      >
                        <option value="">{t('skip')}</option>
                        <option value="user:email">{t('userEmail')}</option>
                        <option value="user:username">{t('userUsername')}</option>
                        {preview.items.map((it) => (
                          <option key={`g${it.id}`} value={`grade:${it.id}`}>
                            {t('gradeOf', { name: it.name })}
                          </option>
                        ))}
                        {preview.items.map((it) => (
                          <option key={`f${it.id}`} value={`feedback:${it.id}`}>
                            {t('feedbackOf', { name: it.name })}
                          </option>
                        ))}
                      </Select>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </section>
          <Alert variant={preview.totals.errors ? 'warning' : 'info'} aria-live="polite">
            {t('totals', preview.totals)}
          </Alert>
          <section aria-labelledby="grade-import-rows" className="grid gap-2">
            <h4 id="grade-import-rows" className="text-sm font-medium">
              {t('rows')}
            </h4>
            <Table className="table-fixed">
              <THead>
                <Tr>
                  <Th className="w-16">{t('line')}</Th>
                  <Th>{t('student')}</Th>
                  <Th>{t('changes')}</Th>
                  <Th>{t('problems')}</Th>
                </Tr>
              </THead>
              <TBody>
                {preview.rows.map((r) => (
                  <Tr key={r.line}>
                    <Td className="tabular-nums">{r.line}</Td>
                    <Td className="break-words">{r.user?.name ?? r.key}</Td>
                    <Td className="break-words text-sm">
                      {r.user
                        ? r.changes
                            .map(
                              (c) =>
                                `${itemName(c.itemId)}: ${c.grade ?? ''}${c.feedback ? ` (${t('withFeedback')})` : ''}`,
                            )
                            .join('; ')
                        : '—'}
                    </Td>
                    <Td className="break-words text-sm text-destructive">{say(r.problems)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            {preview.problems.some((p) => !preview.rows.some((r) => r.line === p.line)) ? (
              <ul className="list-disc pl-5 text-sm text-destructive">
                {preview.problems
                  .filter((p) => !preview.rows.some((r) => r.line === p.line))
                  .map((p) => (
                    <li key={p.line}>
                      {p.line}: {say(p.problems)}
                    </li>
                  ))}
              </ul>
            ) : null}
          </section>
          {mapping.userColumn < 0 ? (
            <p className="text-sm text-destructive">{t('noUserColumn')}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending || mapping.userColumn < 0}
              onClick={() => show(mapping)}
            >
              {t('refresh')}
            </Button>
            <Button
              type="button"
              disabled={pending || mapping.userColumn < 0 || !mapping.columns.length}
              onClick={apply}
            >
              {t('apply')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
