import { frameworkTree, ScaleConfig, taxonomyAt } from '@hubium/core';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  Select,
} from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CompetencyForm, FrameworkForm, RuleForm } from '@/components/competencies/forms';
import { CommandButton } from '@/components/confirm-button';
import {
  addRelatedAction,
  deleteCompetencyAction,
  deleteFrameworkAction,
  duplicateFrameworkAction,
  moveCompetencyAction,
  reorderCompetencyAction,
  setRelatedAction,
} from '@/server/actions/competencies';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('competencies', 'frameworks');

export default async function FrameworkPage({
  params,
  searchParams,
}: {
  params: Promise<{ frameworkId: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  await requireCapability('competency:manage');
  const { frameworkId } = await params;
  const { c: selectedId } = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(frameworkId)) notFound();
  const tree = await frameworkTree(db, frameworkId).catch(() => null);
  if (!tree) notFound();
  const [t, tc, scales] = await Promise.all([
    getTranslations('competencies'),
    getTranslations('common'),
    db.scale.findMany({ where: { courseId: null }, orderBy: { name: 'asc' } }),
  ]);
  const { framework: f, competencies } = tree;
  const scaleOptions = scales.map((s) => ({ id: s.id, name: s.name, items: s.items }));
  const base = `/admin/competencies/${f.id}`;
  const selected = competencies.find((c) => c.id === selectedId) ?? null;
  const byId = new Map(competencies.map((c) => [c.id, c]));
  const below = selected
    ? competencies.filter((c) => c.id === selected.id || c.path.includes(`/${selected.id}/`))
    : [];
  const label = (c: { shortName: string; idNumber: string }) => `${c.shortName} (${c.idNumber})`;
  return (
    <>
      <PageHeader
        title={f.shortName}
        description={
          <span className="flex flex-wrap gap-x-3">
            <Link href="/admin/competencies" className="hover:underline">
              ← {t('frameworks')}
            </Link>
            <span className="font-mono text-xs">{f.idNumber}</span>
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary" size="sm">
              <a href={`${base}/export`}>{t('exportCsv')}</a>
            </Button>
            <CommandButton
              size="sm"
              variant="secondary"
              run={duplicateFrameworkAction.bind(null, f.id)}
              success={t('duplicated')}
            >
              {t('duplicate')}
            </CommandButton>
            <CommandButton
              size="sm"
              variant="destructive"
              confirm={`${tc('delete')}: ${f.shortName}?`}
              run={deleteFrameworkAction.bind(null, f.id)}
            >
              {tc('delete')}
            </CommandButton>
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_26rem]">
        <Card className="h-fit min-w-0">
          <CardHeader>
            <CardTitle>{t('tree')}</CardTitle>
          </CardHeader>
          <CardContent>
            {competencies.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('emptyFramework')}</p>
            ) : (
              <ul className="grid gap-0.5 text-sm">
                {competencies.map((c) => (
                  <li key={c.id} style={{ paddingLeft: `${c.depth * 1.25}rem` }}>
                    <Link
                      href={`${base}?c=${c.id}`}
                      aria-current={c.id === selected?.id ? 'true' : undefined}
                      className={cn(
                        'flex flex-wrap items-baseline gap-x-2 rounded px-1.5 py-1 hover:bg-muted',
                        c.id === selected?.id && 'bg-accent-soft',
                      )}
                    >
                      <span className="text-xs text-muted-foreground">
                        {t(`taxonomy.${taxonomyAt(f.taxonomies, c.depth)}`)}
                      </span>
                      <span>{c.shortName}</span>
                      <span className="font-mono text-xs text-muted-foreground">{c.idNumber}</span>
                      {c.ruleType ? (
                        <Badge variant="accent">{t(`rules.${c.ruleType}`)}</Badge>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="grid h-fit gap-6">
          {selected ? (
            <>
              <Card>
                <CardHeader className="flex-row items-center justify-between gap-2">
                  <CardTitle>{selected.shortName}</CardTitle>
                  <Link href={base} className="text-sm text-muted-foreground hover:underline">
                    {tc('close')}
                  </Link>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <CompetencyForm
                    key={selected.id}
                    idPrefix="edit"
                    frameworkId={f.id}
                    competency={{
                      id: selected.id,
                      shortName: selected.shortName,
                      idNumber: selected.idNumber,
                      description: selected.description,
                      scaleId: selected.scaleId,
                      scaleConfig: selected.scaleConfig
                        ? ScaleConfig.parse(selected.scaleConfig)
                        : null,
                    }}
                    scales={scaleOptions}
                  />
                  <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                    <CommandButton
                      size="sm"
                      variant="secondary"
                      run={reorderCompetencyAction.bind(null, selected.id, 'up')}
                    >
                      {t('moveUp')}
                    </CommandButton>
                    <CommandButton
                      size="sm"
                      variant="secondary"
                      run={reorderCompetencyAction.bind(null, selected.id, 'down')}
                    >
                      {t('moveDown')}
                    </CommandButton>
                    <CommandButton
                      size="sm"
                      variant="destructive"
                      confirm={`${tc('delete')}: ${selected.shortName}?`}
                      run={deleteCompetencyAction.bind(null, selected.id)}
                    >
                      {tc('delete')}
                    </CommandButton>
                  </div>
                  <ActionForm
                    action={moveCompetencyAction}
                    success={tc('saved')}
                    className="flex flex-wrap items-end gap-2"
                  >
                    <input type="hidden" name="id" value={selected.id} />
                    <FormField
                      name="parentId"
                      id="move-parent"
                      label={t('parent')}
                      className="min-w-56 flex-1"
                    >
                      <Select
                        id="move-parent"
                        name="parentId"
                        defaultValue={selected.parentId ?? ''}
                      >
                        <option value="">{t('topLevel')}</option>
                        {competencies
                          .filter((c) => !below.includes(c))
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {label(c)}
                            </option>
                          ))}
                      </Select>
                    </FormField>
                    <SubmitButton variant="secondary">{t('move')}</SubmitButton>
                  </ActionForm>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t('rule')}</CardTitle>
                </CardHeader>
                <CardContent>
                  {selected.children.length ? (
                    <RuleForm
                      key={selected.id}
                      competencyId={selected.id}
                      rule={{
                        type: selected.ruleType,
                        outcome: selected.ruleOutcome,
                        config: selected.ruleConfig as never,
                      }}
                      kids={selected.children.map((id) => ({
                        id,
                        shortName: byId.get(id)?.shortName ?? id,
                      }))}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('ruleNeedsChildren')}</p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t('related')}</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3">
                  {selected.related.length ? (
                    <ul className="grid gap-1 text-sm">
                      {selected.related.map((id) => (
                        <li key={id} className="flex items-center justify-between gap-2">
                          <Link href={`${base}?c=${id}`} className="hover:underline">
                            {label(byId.get(id)!)}
                          </Link>
                          <CommandButton
                            size="sm"
                            variant="ghost"
                            aria-label={`${tc('delete')}: ${byId.get(id)!.shortName}`}
                            run={setRelatedAction.bind(null, selected.id, id, false)}
                          >
                            ×
                          </CommandButton>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('noRelated')}</p>
                  )}
                  <ActionForm action={addRelatedAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="id" value={selected.id} />
                    <FormField
                      name="relatedId"
                      id="related-id"
                      label={t('addRelated')}
                      className="min-w-56 flex-1"
                    >
                      <Select id="related-id" name="relatedId">
                        {competencies
                          .filter((c) => c.id !== selected.id && !selected.related.includes(c.id))
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {label(c)}
                            </option>
                          ))}
                      </Select>
                    </FormField>
                    <SubmitButton variant="secondary">{tc('add')}</SubmitButton>
                  </ActionForm>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t('addChild')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <CompetencyForm
                    key={`child-${selected.id}`}
                    idPrefix="child"
                    frameworkId={f.id}
                    parentId={selected.id}
                    scales={scaleOptions}
                  />
                </CardContent>
              </Card>
            </>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>{t('addTop')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <CompetencyForm idPrefix="top" frameworkId={f.id} scales={scaleOptions} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t('settings')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <FrameworkForm
                    framework={{
                      id: f.id,
                      shortName: f.shortName,
                      idNumber: f.idNumber,
                      description: f.description,
                      scaleId: f.scaleId,
                      scaleConfig: ScaleConfig.parse(f.scaleConfig),
                      taxonomies: f.taxonomies,
                      visible: f.visible,
                    }}
                    scales={scaleOptions}
                  />
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}
