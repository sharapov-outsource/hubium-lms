import { AI_FEATURES, getSetting, listAiProviders, usageSummary } from '@hubium/core';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import { CommandButton } from '@/components/confirm-button';
import { deleteAiProviderAction, reindexAllAction } from '@/server/actions/ai';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { EmbeddingsForm, FeatureForm, ProviderForm, type ProviderValues, SiteForm } from './forms';

export const generateMetadata = titled('adminAi', 'title');

export default async function AdminAiPage() {
  await requireCapability('site:config');
  const [t, ta, format] = await Promise.all([
    getTranslations('adminAi'),
    getTranslations('ai'),
    getFormatter(),
  ]);
  const [enabled, notice, providers, features, emb, usage] = await Promise.all([
    getSetting(db, 'ai.enabled'),
    getSetting(db, 'ai.notice'),
    listAiProviders(db),
    db.aiFeatureConfig.findMany(),
    db.aiEmbeddingConfig.findUnique({ where: { id: 'default' } }),
    usageSummary(db, 30),
  ]);
  const courseNames = new Map(
    (
      await db.course.findMany({
        where: { id: { in: usage.topCourses.map((c) => c.courseId) } },
        select: { id: true, fullName: true },
      })
    ).map((c) => [c.id, c.fullName]),
  );
  return (
    <div className="grid max-w-4xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      <Card>
        <CardHeader>
          <CardTitle>{t('site')}</CardTitle>
        </CardHeader>
        <CardContent>
          <SiteForm enabled={enabled} notice={notice} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('providers')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6">
          {providers.map((p) => (
            <div key={p.id} className="grid gap-3 border-b pb-6">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="mr-auto">{p.name}</strong>
                <Badge>{p.kind}</Badge>
                {p.enabled ? null : <Badge variant="warning">{t('disabled')}</Badge>}
                <CommandButton
                  size="sm"
                  variant="ghost"
                  confirm={t('deleteConfirm')}
                  run={deleteAiProviderAction.bind(null, p.id)}
                >
                  {t('delete')}
                </CommandButton>
              </div>
              <ProviderForm p={p as unknown as ProviderValues} />
            </div>
          ))}
          <div className="grid gap-3">
            <h3 className="font-medium">{t('addProvider')}</h3>
            <ProviderForm />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('features')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6">
          {AI_FEATURES.map((feature) => {
            const f = features.find((x) => x.feature === feature);
            return (
              <div key={feature} className="border-b pb-6 last:border-0 last:pb-0">
                <FeatureForm
                  providers={providers.map((p) => ({ id: p.id, name: p.name }))}
                  f={{
                    feature,
                    enabled: f?.enabled ?? false,
                    providerId: f?.providerId ?? null,
                    model: f?.model ?? 'generation',
                    effort: f?.effort ?? null,
                    limits: {
                      userDailyTokens: null,
                      courseMonthlyTokens: null,
                      perMinute: null,
                      ...((f?.limits ?? {}) as object),
                    },
                  }}
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle>{t('embeddings')}</CardTitle>
          <CommandButton
            size="sm"
            variant="outline"
            run={reindexAllAction}
            success={t('reindexQueued')}
          >
            {t('reindex')}
          </CommandButton>
        </CardHeader>
        <CardContent>
          <EmbeddingsForm
            e={
              emb
                ? {
                    kind: emb.kind,
                    baseUrl: emb.baseUrl,
                    model: emb.model,
                    hasKey: !!emb.apiKeyEnc,
                  }
                : null
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {t('usage', { since: format.dateTime(usage.since, { dateStyle: 'medium' }) })}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {usage.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noUsage')}</p>
          ) : (
            <Table>
              <THead>
                <Tr>
                  <Th>{t('feature')}</Th>
                  <Th>{t('status')}</Th>
                  <Th>{t('requests')}</Th>
                  <Th>{t('inputTokens')}</Th>
                  <Th>{t('outputTokens')}</Th>
                  <Th>{t('cacheRead')}</Th>
                </Tr>
              </THead>
              <TBody>
                {usage.rows.map((r) => (
                  <Tr key={`${r.feature}-${r.status}`}>
                    <Td>{ta(`features.${r.feature}`)}</Td>
                    <Td>
                      <Badge variant={r.status === 'OK' ? 'success' : 'warning'}>{r.status}</Badge>
                    </Td>
                    <Td className="tabular-nums">{format.number(r.requests)}</Td>
                    <Td className="tabular-nums">{format.number(r.inputTokens)}</Td>
                    <Td className="tabular-nums">{format.number(r.outputTokens)}</Td>
                    <Td className="tabular-nums">{format.number(r.cacheReadTokens)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
          {usage.topCourses.length ? (
            <div>
              <h3 className="mb-2 text-sm font-medium">{t('topCourses')}</h3>
              <ul className="grid gap-1 text-sm">
                {usage.topCourses.map((c) => (
                  <li key={c.courseId} className="flex justify-between gap-2">
                    <span>{courseNames.get(c.courseId) ?? c.courseId}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {format.number(c.tokens)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
