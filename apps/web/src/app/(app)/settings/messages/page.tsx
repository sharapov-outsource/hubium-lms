import { listBlockedUsers } from '@hubium/core';
import { Avatar, Card, CardContent, CardHeader, CardTitle, Field, Select } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { CommandButton } from '@/components/confirm-button';
import { blockUserAction, setMessagePrivacyAction } from '@/server/actions/comms';
import { db } from '@/server/db';
import { requireUser } from '@/server/session';

export default async function MessageSettingsPage() {
  const user = await requireUser();
  const [t, tc] = await Promise.all([getTranslations('messages'), getTranslations('common')]);
  const blocked = await listBlockedUsers(db, user.id);
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('privacy')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={setMessagePrivacyAction} success={t('saved')} className="grid gap-4">
            <Field label={t('privacy')} htmlFor="privacy" className="max-w-sm">
              <Select id="privacy" name="privacy" defaultValue={user.messagePrivacy}>
                {(['ANYONE', 'COURSEMATES', 'NOBODY'] as const).map((p) => (
                  <option key={p} value={p}>
                    {t(`privacyOptions.${p}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <SubmitButton className="w-fit">{tc('save')}</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('blockedUsers')}</CardTitle>
        </CardHeader>
        <CardContent>
          {blocked.length ? (
            <ul className="grid gap-2">
              {blocked.map((u) => (
                <li key={u.id} className="flex items-center gap-3">
                  <Avatar name={u.name} src={u.image} size={32} />
                  <span className="flex-1">{u.name}</span>
                  <CommandButton
                    size="sm"
                    variant="outline"
                    run={blockUserAction.bind(null, u.id, false)}
                  >
                    {t('unblock')}
                  </CommandButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('noBlocked')}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
