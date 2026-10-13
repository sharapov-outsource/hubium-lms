import { getAllSettings, pendingPolicies, pickLocalized, siteLocale } from '@hubium/core';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Markdown } from '@/components/ai/markdown';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireUser } from '@/server/session';
import { AcceptPoliciesForm } from './accept-form';

export const generateMetadata = titled('policies', 'title');

export default async function PoliciesPage() {
  const user = await requireUser();
  const pending = await pendingPolicies(db, user.id);
  if (!pending.length) redirect('/dashboard');
  const [t, locale, settings] = await Promise.all([
    getTranslations('policies'),
    getLocale(),
    getAllSettings(db),
  ]);
  const pick = (v: Record<string, string>) => pickLocalized(v, locale, siteLocale(settings));
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </div>
      {pending.map((p) => (
        <section
          key={p.versionId}
          aria-labelledby={`p-${p.versionId}`}
          className="grid gap-2 rounded-lg border bg-background p-4"
        >
          <h2 id={`p-${p.versionId}`} className="text-lg font-medium">
            {pick(p.name)}
          </h2>
          <div className="max-h-80 overflow-y-auto">
            <Markdown text={pick(p.content)} />
          </div>
        </section>
      ))}
      <AcceptPoliciesForm versionIds={pending.map((p) => p.versionId)} />
    </div>
  );
}
