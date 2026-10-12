import type { ViewProps } from '@hubium/module-sdk/ui';
import { Alert, Button } from '@hubium/ui';
import { ExternalLink, ListPlus } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { LtiSettingsT } from '../server.ts';

type Props = ViewProps<LtiSettingsT>;

export async function LtiView({ activity: a, ctx, searchParams }: Props) {
  const t = await getTranslations('mod.lti');
  const tool = await ctx.db.ltiTool.findUnique({ where: { id: a.settings.toolId } });
  if (!tool) return <Alert variant="warning">{t('toolMissing')}</Alert>;
  if (!tool.enabled) return <Alert variant="warning">{t('toolDisabled')}</Alert>;
  const canManage = await ctx.perm.can('mod.lti:manage', a.courseId);
  const launch = `/api/mod/lti/launch/${a.id}`;
  const selecting = canManage && searchParams.select === '1' && !!tool.deepLinkingUrl;
  const src = selecting ? `${launch}?dl=1` : launch;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground">
          {tool.name}
          {a.settings.contentTitle ? ` · ${a.settings.contentTitle}` : ''}
        </span>
        <a
          href={launch}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-accent hover:underline"
        >
          <ExternalLink className="size-4" aria-hidden />
          {t('openNewWindow')}
        </a>
        {canManage && tool.deepLinkingUrl && !selecting ? (
          <Button asChild size="sm" variant="outline">
            <a href={`/course/${a.courseId}/a/${a.id}?select=1`}>
              <ListPlus aria-hidden />
              {t('selectContent')}
            </a>
          </Button>
        ) : null}
      </div>
      {a.settings.container === 'window' && !selecting ? (
        <Button asChild className="w-fit">
          <a href={launch} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden />
            {t('launch')}
          </a>
        </Button>
      ) : (
        <iframe
          src={src}
          title={tool.name}
          className="w-full rounded-lg border border-border bg-white"
          style={{ height: a.settings.height }}
          allow="fullscreen; clipboard-write; camera; microphone"
        />
      )}
    </div>
  );
}
