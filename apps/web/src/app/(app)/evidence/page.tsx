import { ForbiddenError, planCompetencyIds, userEvidenceList } from '@hubium/core';
import { fileUrl } from '@hubium/core/files/files';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Textarea,
} from '@hubium/ui';
import Link from 'next/link';
import { forbidden, notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CompetencyPicker } from '@/components/competencies/picker';
import { CommandButton } from '@/components/confirm-button';
import { isWebLink } from '@/lib/web-link';
import {
  deleteUserEvidenceAction,
  saveUserEvidenceAction,
  unlinkUserEvidenceAction,
} from '@/server/actions/competencies';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { getContext, requireUser } from '@/server/session';

export const generateMetadata = titled('competencies', 'evidencePage');

/** Evidence of prior learning: links and files a person ties to the competencies of their plans. */
export default async function EvidencePage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const me = await requireUser();
  const { user } = await searchParams;
  const userId = user && /^[0-9a-f-]{36}$/.test(user) ? user : me.id;
  const ctx = await getContext();
  const data = await userEvidenceList(ctx, userId).catch((e) => {
    if (e instanceof ForbiddenError) forbidden();
    notFound();
  });
  const [t, tc, format] = await Promise.all([
    getTranslations('competencies'),
    getTranslations('common'),
    getFormatter(),
  ]);
  // what to tie evidence to: the competencies of the person's plans
  const plans = await db.learningPlan.findMany({ where: { userId } });
  const ids = [...new Set((await Promise.all(plans.map((p) => planCompetencyIds(db, p)))).flat())];
  const comps = await db.competency.findMany({
    where: { id: { in: ids } },
    include: { framework: { select: { id: true, shortName: true } } },
    orderBy: { shortName: 'asc' },
  });
  const frameworks = [...new Map(comps.map((c) => [c.framework.id, c.framework])).values()].map(
    (f) => ({
      id: f.id,
      shortName: f.shortName,
      competencies: comps
        .filter((c) => c.frameworkId === f.id)
        .map((c) => ({ id: c.id, shortName: c.shortName, idNumber: c.idNumber, depth: 0 })),
    }),
  );
  return (
    <>
      <PageHeader
        title={t('evidencePage')}
        description={
          <Link
            href={userId === me.id ? '/plans' : `/plans?user=${userId}`}
            className="hover:underline"
          >
            ← {t('plansTitle')}
          </Link>
        }
      />
      <div className={data.manage ? 'grid gap-6 lg:grid-cols-[1fr_22rem]' : ''}>
        <div className="grid min-w-0 content-start gap-3">
          {data.items.length === 0 ? <EmptyState title={t('noEvidence')} /> : null}
          {data.items.map((e) => (
            <Card key={e.id}>
              <CardContent className="grid gap-3 pt-6">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="font-semibold">{e.name}</h2>
                    <p className="text-xs text-muted-foreground">
                      {format.dateTime(e.createdAt, { dateStyle: 'medium' })}
                    </p>
                  </div>
                  {data.manage ? (
                    <CommandButton
                      size="sm"
                      variant="ghost"
                      confirm={`${tc('delete')}: ${e.name}?`}
                      run={deleteUserEvidenceAction.bind(null, e.id)}
                    >
                      {tc('delete')}
                    </CommandButton>
                  ) : null}
                </div>
                {e.description ? (
                  <p className="whitespace-pre-line text-sm text-muted-foreground">
                    {e.description}
                  </p>
                ) : null}
                {e.url && isWebLink(e.url) ? (
                  <a
                    href={e.url}
                    className="break-all text-sm text-accent hover:underline"
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    {e.url}
                  </a>
                ) : null}
                {e.files.length ? (
                  <ul className="grid gap-1 text-sm">
                    {e.files.map((f) => (
                      <li key={f.id}>
                        <a href={fileUrl(f)} className="text-accent hover:underline">
                          {f.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="flex flex-wrap gap-2 text-sm">
                  {e.competencies.map((c) => (
                    <span
                      key={c.competencyId}
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5"
                    >
                      <Link
                        href={`/competencies/user/${userId}/${c.competencyId}`}
                        className="hover:underline"
                      >
                        {c.competency.shortName}
                      </Link>
                      {data.manage ? (
                        <CommandButton
                          size="sm"
                          variant="ghost"
                          className="h-5 px-1"
                          aria-label={`${tc('delete')}: ${c.competency.shortName}`}
                          run={unlinkUserEvidenceAction.bind(null, e.id, c.competencyId)}
                        >
                          ×
                        </CommandButton>
                      ) : null}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        {data.manage ? (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>{t('newEvidence')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ActionForm
                action={saveUserEvidenceAction}
                success={tc('saved')}
                resetOnSuccess
                className="grid gap-3"
              >
                <input type="hidden" name="userId" value={userId} />
                <FormField name="name" id="ue-name" label={t('name')} required />
                <FormField name="description" id="ue-description" label={t('description')}>
                  <Textarea id="ue-description" name="description" />
                </FormField>
                <FormField name="url" id="ue-url" type="url" label={t('link')} />
                <FormField name="files" id="ue-files" type="file" multiple label={t('files')} />
                <div>
                  <SubmitButton>{tc('save')}</SubmitButton>
                </div>
              </ActionForm>
              {data.items.length && frameworks.length ? (
                <div className="mt-6 grid gap-2 border-t border-border pt-4">
                  <h3 className="text-sm font-medium">{t('tieEvidence')}</h3>
                  {data.items.map((e) => (
                    <details key={e.id} className="text-sm">
                      <summary className="cursor-pointer">{e.name}</summary>
                      <div className="mt-2">
                        <CompetencyPicker
                          frameworks={frameworks}
                          exclude={e.competencies.map((c) => c.competencyId)}
                          action={saveUserEvidenceAction}
                          hidden={{
                            id: e.id,
                            name: e.name,
                            description: e.description,
                            url: e.url,
                          }}
                          label={t('choose')}
                          submit={t('tie')}
                        />
                      </div>
                    </details>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
