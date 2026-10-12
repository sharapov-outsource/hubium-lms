import { getNotificationPreferences, pushConfig } from '@hubium/core';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Select,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { serverModules } from '@/modules/server';
import { saveNotificationPrefsAction } from '@/server/actions/comms';
import { db } from '@/server/db';
import { requireUser } from '@/server/session';
import { PushToggle } from './push-toggle';

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export default async function NotificationSettingsPage() {
  const user = await requireUser();
  const [t, tAll, tc] = await Promise.all([
    getTranslations('notifications.prefs'),
    getTranslations(),
    getTranslations('common'),
  ]);
  const prefs = await getNotificationPreferences(
    db,
    user.id,
    serverModules.map((m) => m.key),
  );
  const label = (key: string) => (tAll.has(key) ? tAll(key) : key);
  const push = pushConfig();
  return (
    <div className="grid gap-6">
      {push ? <PushToggle publicKey={push.publicKey} /> : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm
            action={saveNotificationPrefsAction}
            success={t('saved')}
            className="grid gap-6"
          >
            <Table>
              <THead>
                <Tr>
                  <Th>{t('type')}</Th>
                  <Th className="w-24 text-center">{t('inApp')}</Th>
                  <Th className="w-52">{t('email')}</Th>
                  {push ? <Th className="w-24 text-center">{t('push')}</Th> : null}
                </Tr>
              </THead>
              <TBody>
                {prefs.types.map((p) => (
                  <Tr key={p.type}>
                    <Td>
                      <input type="hidden" name="type" value={p.type} />
                      <span id={`l-${p.type}`}>{label(p.labelKey)}</span>
                    </Td>
                    <Td className="text-center">
                      <Checkbox
                        name={`inApp:${p.type}`}
                        defaultChecked={p.inApp}
                        aria-label={`${label(p.labelKey)}: ${t('inApp')}`}
                      />
                    </Td>
                    <Td>
                      <Select
                        name={`email:${p.type}`}
                        defaultValue={p.email}
                        aria-label={`${label(p.labelKey)}: ${t('email')}`}
                      >
                        {(['IMMEDIATE', 'DIGEST', 'OFF'] as const).map((m) => (
                          <option key={m} value={m}>
                            {t(`emailModes.${m}`)}
                          </option>
                        ))}
                      </Select>
                    </Td>
                    {push ? (
                      <Td className="text-center">
                        <Checkbox
                          name={`push:${p.type}`}
                          defaultChecked={p.push}
                          aria-label={`${label(p.labelKey)}: ${t('push')}`}
                        />
                      </Td>
                    ) : null}
                  </Tr>
                ))}
              </TBody>
            </Table>
            <Field label={t('digestHour')} htmlFor="digestHour" className="max-w-xs">
              <Select id="digestHour" name="digestHour" defaultValue={String(prefs.digestHour)}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {`${String(h).padStart(2, '0')}:00`}
                  </option>
                ))}
              </Select>
            </Field>
            <SubmitButton className="w-fit">{tc('save')}</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
