import { getAllSettings, isModuleEnabled } from '@hubium/core';
import { platformInfo } from '@hubium/mod-lti/server';
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@hubium/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { CommandButton } from '@/components/confirm-button';
import { deleteLtiToolAction, rotateLtiKeyAction } from '@/server/actions/lti';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { ToolForm } from './tool-form';

export const generateMetadata = titled('adminLti', 'title');

function Info({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="grid gap-0.5 sm:grid-cols-[12rem_1fr]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono text-xs">{value}</dd>
    </div>
  );
}

export default async function LtiToolsPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  await requireCapability('site:config');
  const [t, sp] = await Promise.all([getTranslations('adminLti'), searchParams]);
  if (!isModuleEnabled(await getAllSettings(db), 'lti'))
    return (
      <div className="grid max-w-4xl gap-6">
        <PageHeader title={t('title')} description={t('description')} className="mb-0" />
        <Alert variant="warning">
          {t.rich('turnedOff', {
            link: (chunks) => (
              <Link href="/admin/modules" className="underline">
                {chunks}
              </Link>
            ),
          })}
        </Alert>
      </div>
    );
  const tools = await db.ltiTool.findMany({ orderBy: { name: 'asc' } });
  // activities of courses (the recycle bin's too) that launch each tool
  const uses = new Map(
    (
      await db.$queryRaw<{ toolId: string; n: number }[]>`
        SELECT settings->>'toolId' AS "toolId", count(*)::int AS n
          FROM "Activity" WHERE "moduleKey" = 'lti' GROUP BY 1`
    ).map((r) => [r.toolId, r.n]),
  );
  const editing = sp.edit ? tools.find((x) => x.id === sp.edit) : undefined;
  const platform = platformInfo();
  return (
    <div className="grid max-w-4xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle>{t('platform')}</CardTitle>
          <CommandButton
            size="sm"
            variant="outline"
            confirm={t('rotateConfirm')}
            run={rotateLtiKeyAction}
            success={t('rotated')}
          >
            {t('rotate')}
          </CommandButton>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-2">
            <Info label={t('issuer')} value={platform.issuer} />
            <Info label={t('authUrl')} value={platform.authUrl} />
            <Info label={t('tokenUrl')} value={platform.tokenUrl} />
            <Info label={t('jwksUrl')} value={platform.jwksUrl} />
          </dl>
        </CardContent>
      </Card>
      {tools.map((tool) => (
        <Card key={tool.id}>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle>
              {tool.name} {tool.enabled ? null : <Badge variant="warning">{t('disabled')}</Badge>}
            </CardTitle>
            <span className="text-sm text-muted-foreground">
              {t('usedBy', { n: uses.get(tool.id) ?? 0 })}
            </span>
            <div className="flex gap-2">
              <a
                href={`/admin/lti?edit=${tool.id}`}
                className="text-sm text-accent hover:underline"
              >
                {t('edit')}
              </a>
              <CommandButton
                size="sm"
                variant="ghost"
                confirm={
                  uses.get(tool.id)
                    ? t('deleteUsedConfirm', { name: tool.name, n: uses.get(tool.id)! })
                    : t('deleteConfirm', { name: tool.name })
                }
                run={deleteLtiToolAction.bind(null, tool.id)}
              >
                {t('delete')}
              </CommandButton>
            </div>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2">
              <Info label={t('clientId')} value={tool.clientId} />
              <Info label={t('deploymentId')} value={tool.deploymentId} />
              <Info label={t('loginUrl')} value={tool.oidcLoginUrl} />
              <Info label={t('targetLinkUri')} value={tool.targetLinkUri} />
              <Info label={t('deepLinkingUrl')} value={tool.deepLinkingUrl ?? undefined} />
            </dl>
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader>
          <CardTitle>{editing ? t('editTool', { name: editing.name }) : t('newTool')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ToolForm
            key={editing?.id ?? 'new'}
            tool={
              editing
                ? {
                    id: editing.id,
                    name: editing.name,
                    oidcLoginUrl: editing.oidcLoginUrl,
                    targetLinkUri: editing.targetLinkUri,
                    redirectUris: editing.redirectUris.join('\n'),
                    jwksUrl: editing.jwksUrl ?? '',
                    publicKeyPem: editing.publicKeyPem ?? '',
                    deepLinkingUrl: editing.deepLinkingUrl ?? '',
                    customParams: Object.entries(editing.customParams as Record<string, string>)
                      .map(([k, v]) => `${k}=${v}`)
                      .join('\n'),
                    sendName: editing.sendName,
                    sendEmail: editing.sendEmail,
                    enabled: editing.enabled,
                  }
                : undefined
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
