import { moduleOverview } from '@hubium/core';
import {
  Alert,
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
import { ModuleIcon } from '@/components/module-icon';
import { saveModulesAction } from '@/server/actions/admin';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('adminModules', 'title');

export default async function AdminModulesPage() {
  const { ctx } = await requireCapability('site:config');
  const [t, tm, tc, rows] = await Promise.all([
    getTranslations('adminModules'),
    getTranslations('mod'),
    getTranslations('common'),
    moduleOverview(ctx),
  ]);
  const tracked = rows.filter((r) => !r.enabled && r.tracked > 0);
  return (
    <div className="grid max-w-5xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      {tracked.length ? (
        <Alert variant="warning">
          {t('trackedWarning', {
            modules: tracked.map((r) => tm(`${r.key}.name` as never)).join(', '),
          })}
        </Alert>
      ) : null}
      <ActionForm action={saveModulesAction} success={tc('saved')} className="grid gap-6">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{t('types')}</CardTitle>
            <CardDescription>{t('hint')}</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('module')}
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    {t('activities')}
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    {t('courses')}
                  </th>
                  <th scope="col" className="py-2 text-center font-medium">
                    {t('enabled')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((m) => {
                  const name = tm(`${m.key}.name` as never);
                  return (
                    <tr key={m.key} className="align-top">
                      <th scope="row" className="py-3 pr-3 text-left font-normal">
                        <span className="flex items-start gap-3">
                          <ModuleIcon icon={m.icon} archetype={m.archetype} />
                          <span className="min-w-0">
                            <span className="font-medium">{name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {tm(`${m.key}.description` as never)}
                            </span>
                            {m.required ? <Badge className="mt-1">{t('required')}</Badge> : null}
                          </span>
                        </span>
                      </th>
                      <td className="py-3 pr-3 text-right tabular-nums">{m.activities}</td>
                      <td className="py-3 pr-3 text-right tabular-nums">{m.courses}</td>
                      <td className="py-3 text-center">
                        {m.required ? (
                          <>
                            <input type="hidden" name="enabled" value={m.key} />
                            <Checkbox
                              defaultChecked
                              disabled
                              aria-label={`${t('enabled')}: ${name}`}
                            />
                          </>
                        ) : (
                          <Checkbox
                            name="enabled"
                            value={m.key}
                            defaultChecked={m.enabled}
                            aria-label={`${t('enabled')}: ${name}`}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-muted-foreground">{t('keepsData')}</p>
            <div className="mt-4">
              <SubmitButton>{tc('save')}</SubmitButton>
            </div>
          </CardContent>
        </Card>
      </ActionForm>
    </div>
  );
}
