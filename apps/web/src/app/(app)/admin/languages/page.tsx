import { languageOverview } from '@hubium/core';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  PageHeader,
} from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { saveLanguagesAction } from '@/server/actions/admin';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('adminLanguages', 'title');

/** Strings listed under a pack before "and N more". */
const SHOWN = 100;

export default async function AdminLanguagesPage() {
  const { ctx } = await requireCapability('site:config');
  const [t, tc, overview] = await Promise.all([
    getTranslations('adminLanguages'),
    getTranslations('common'),
    languageOverview(ctx),
  ]);
  return (
    <div className="grid max-w-5xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      <ActionForm action={saveLanguagesAction} success={tc('saved')} className="grid gap-6">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{t('packs')}</CardTitle>
            <CardDescription>{t('howToAdd')}</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('language')}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('translated')}
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    {t('users')}
                  </th>
                  <th scope="col" className="py-2 pr-3 text-center font-medium">
                    {t('enabled')}
                  </th>
                  <th scope="col" className="py-2 text-center font-medium">
                    {t('siteLanguage')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {overview.rows.map((l) => {
                  const problems = [
                    ...l.report.missing.map((k) => `${k} — ${t('missingKey')}`),
                    ...l.report.invalid.map((i) => `${i.key} — ${i.reason}`),
                    ...l.report.unknown.map((k) => `${k} — ${t('unknownKey')}`),
                  ];
                  return (
                    <tr key={l.code} className="align-top">
                      <th scope="row" className="py-3 pr-3 text-left font-normal">
                        <span lang={l.code} className="font-medium">
                          {l.name}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {l.englishName} · <code>{l.code}</code>
                        </span>
                        {l.isBase ? <Badge className="mt-1">{t('base')}</Badge> : null}
                      </th>
                      <td className="py-3 pr-3">
                        <span className="tabular-nums">{l.percent}%</span>
                        {problems.length ? (
                          <details className="mt-1 text-xs">
                            <summary className="cursor-pointer text-muted-foreground">
                              {[
                                l.report.missing.length
                                  ? t('missing', { n: l.report.missing.length })
                                  : null,
                                l.report.invalid.length
                                  ? t('invalid', { n: l.report.invalid.length })
                                  : null,
                                l.report.unknown.length
                                  ? t('unknown', { n: l.report.unknown.length })
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(', ')}
                            </summary>
                            <ul className="mt-1 grid max-h-60 gap-0.5 overflow-y-auto font-mono break-all">
                              {problems.slice(0, SHOWN).map((p) => (
                                <li key={p}>{p}</li>
                              ))}
                              {problems.length > SHOWN ? (
                                <li>{t('more', { n: problems.length - SHOWN })}</li>
                              ) : null}
                            </ul>
                          </details>
                        ) : (
                          <span className="block text-xs text-muted-foreground">
                            {t('complete')}
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-3 text-right tabular-nums">{l.users}</td>
                      <td className="py-3 pr-3 text-center">
                        <Checkbox
                          name="enabled"
                          value={l.code}
                          defaultChecked={l.enabled}
                          aria-label={`${t('enabled')}: ${l.name}`}
                        />
                      </td>
                      <td className="py-3 text-center">
                        <input
                          type="radio"
                          name="defaultLocale"
                          value={l.code}
                          defaultChecked={l.isSite}
                          aria-label={`${t('siteLanguage')}: ${l.name}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-muted-foreground">{t('siteAlwaysEnabled')}</p>
            {overview.orphanedUsers ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('orphaned', { n: overview.orphanedUsers })}
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="grid gap-4 pt-6">
            <label htmlFor="detectBrowser" className="flex items-start gap-2 text-sm">
              <Checkbox
                id="detectBrowser"
                name="detectBrowser"
                defaultChecked={overview.detectBrowser}
                className="mt-0.5"
              />
              <span>
                {t('detectBrowser')}
                <span className="block text-xs text-muted-foreground">
                  {t('detectBrowserHint')}
                </span>
              </span>
            </label>
            <div>
              <SubmitButton>{tc('save')}</SubmitButton>
            </div>
          </CardContent>
        </Card>
      </ActionForm>
    </div>
  );
}
