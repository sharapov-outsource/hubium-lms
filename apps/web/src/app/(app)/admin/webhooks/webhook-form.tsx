'use client';

import { Alert, Button, Checkbox } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ActionForm, FormField, SubmitButton, useFieldError } from '@/components/action-form';
import { createWebhookAction, updateWebhookAction } from '@/server/actions/webhooks';
import { EVENT_GROUPS } from './event-groups';

/** The signing secret, shown once after it is made. */
export function SecretNotice({ secret }: { secret: string }) {
  const t = useTranslations('adminWebhooks');
  return (
    <Alert variant="success" className="grid gap-2">
      <strong>{t('secretTitle')}</strong>
      <span className="text-sm">{t('secretHint')}</span>
      <code
        className="break-all rounded bg-muted p-2 font-mono text-xs"
        data-testid="webhook-secret"
      >
        {secret}
      </code>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-fit"
        onClick={() => {
          void navigator.clipboard?.writeText(secret);
          toast.success(t('copied'));
        }}
      >
        {t('copy')}
      </Button>
    </Alert>
  );
}

function EventsField({ selected }: { selected: string[] }) {
  const t = useTranslations('adminWebhooks');
  const error = useFieldError('events');
  const [checked, setChecked] = useState(() => new Set(selected));
  const all = Object.values(EVENT_GROUPS).flat();
  const toggle = (e: string, on: boolean) => {
    const next = new Set(checked);
    if (on) next.add(e);
    else next.delete(e);
    setChecked(next);
  };
  return (
    <fieldset className="grid gap-3" aria-describedby={error ? 'events-error' : undefined}>
      <legend className="mb-1 flex w-full items-center justify-between gap-2 text-sm font-medium">
        {t('events')}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setChecked(checked.size === all.length ? new Set() : new Set(all))}
        >
          {checked.size === all.length ? t('selectNone') : t('selectAll')}
        </Button>
      </legend>
      <div className="grid gap-4 sm:grid-cols-3">
        {Object.entries(EVENT_GROUPS).map(([group, events]) => (
          <div key={group} className="grid content-start gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t(`groups.${group}`)}
            </span>
            {events.map((e) => (
              <label key={e} htmlFor={`ev-${e}`} className="flex items-start gap-2 text-sm">
                <Checkbox
                  id={`ev-${e}`}
                  name="events"
                  value={e}
                  className="mt-0.5"
                  checked={checked.has(e)}
                  onChange={(ev) => toggle(e, ev.target.checked)}
                />
                <span>
                  {t(`eventNames.${e.replace(/\./g, '_')}`)}
                  <code className="block text-xs text-muted-foreground">{e}</code>
                </span>
              </label>
            ))}
          </div>
        ))}
      </div>
      {error ? (
        <p id="events-error" className="text-sm text-destructive">
          {error.join(' ')}
        </p>
      ) : null}
    </fieldset>
  );
}

export function WebhookForm({
  webhook,
}: {
  webhook?: { id: string; name: string; url: string; events: string[]; enabled: boolean };
}) {
  const t = useTranslations('adminWebhooks');
  const tc = useTranslations('common');
  const router = useRouter();
  const [secret, setSecret] = useState<string | null>(null);
  // A new form after each webhook: the event choices live in state, not in the inputs.
  const [round, setRound] = useState(0);
  if (!webhook) {
    return (
      <div className="grid gap-4">
        <ActionForm
          key={round}
          action={createWebhookAction}
          onSuccess={(r) => {
            setSecret(r.secret);
            setRound((n) => n + 1);
            router.refresh();
          }}
          className="grid gap-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField name="name" label={t('name')} required maxLength={200} />
            <FormField
              name="url"
              label={t('url')}
              type="url"
              required
              placeholder="https://"
              hint={t('urlHint')}
            />
          </div>
          <EventsField selected={[]} />
          <SubmitButton className="w-fit">{t('create')}</SubmitButton>
        </ActionForm>
        {secret ? <SecretNotice secret={secret} /> : null}
      </div>
    );
  }
  return (
    <ActionForm action={updateWebhookAction} success={tc('saved')} className="grid gap-4">
      <input type="hidden" name="id" value={webhook.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          name="name"
          label={t('name')}
          required
          maxLength={200}
          defaultValue={webhook.name}
        />
        <FormField
          name="url"
          label={t('url')}
          type="url"
          required
          defaultValue={webhook.url}
          hint={t('urlHint')}
        />
      </div>
      <EventsField selected={webhook.events} />
      <label htmlFor="wh-enabled" className="flex items-center gap-2 text-sm">
        <Checkbox id="wh-enabled" name="enabled" defaultChecked={webhook.enabled} />
        {t('enabled')}
      </label>
      <SubmitButton className="w-fit">{tc('save')}</SubmitButton>
    </ActionForm>
  );
}
