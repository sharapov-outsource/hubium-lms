import { getFormatter, getTranslations } from 'next-intl/server';
import { isWebLink } from '@/lib/web-link';

/** A learner's evidence on a competency: what happened, where, the rating given, by whom. */
export async function EvidenceList({
  evidence,
  items,
  empty,
}: {
  evidence: {
    id: string;
    action: 'LOG' | 'COMPLETE' | 'OVERRIDE';
    description: string;
    descriptionData: unknown;
    grade: number | null;
    note: string | null;
    url: string | null;
    actor: string | null;
    createdAt: Date;
  }[];
  items: string[];
  empty: string;
}) {
  const [t, format] = await Promise.all([getTranslations('competencies'), getFormatter()]);
  if (!evidence.length)
    return (
      <p className="text-sm text-muted-foreground">
        {t('evidenceTitle')}: {empty}
      </p>
    );
  const known = [
    'activityCompleted',
    'courseCompleted',
    'ruleMet',
    'ratedInCourse',
    'rated',
    'manual',
    'priorLearning',
  ];
  return (
    <div className="grid gap-1">
      <h3 className="text-sm font-medium">{t('evidenceTitle')}</h3>
      <ol className="grid gap-2 text-sm">
        {evidence.map((e) => {
          const values = (e.descriptionData ?? {}) as Record<string, string>;
          return (
            <li key={e.id} className="rounded-md border border-border p-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  {known.includes(e.description)
                    ? t(`evidence.${e.description}`, { name: '', competency: '', ...values })
                    : e.description}
                  {e.action !== 'LOG' ? (
                    <>
                      {' — '}
                      <strong>
                        {e.grade ? (items[e.grade - 1] ?? e.grade) : t('ratingRemoved')}
                      </strong>
                    </>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {format.dateTime(e.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
                  {e.actor ? ` · ${e.actor}` : ''}
                </span>
              </div>
              {e.note ? (
                <p className="mt-1 whitespace-pre-line text-muted-foreground">{e.note}</p>
              ) : null}
              {e.url && isWebLink(e.url) ? (
                <a
                  href={e.url}
                  className="mt-1 block break-all text-accent hover:underline"
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  {e.url}
                </a>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
