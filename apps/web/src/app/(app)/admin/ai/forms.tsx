'use client';

import { Checkbox, Input, Select, Textarea } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import {
  saveAiFeatureAction,
  saveAiProviderAction,
  saveAiSiteAction,
  saveEmbeddingsAction,
} from '@/server/actions/ai';

const Check = ({
  id,
  name,
  label,
  on,
}: {
  id: string;
  name: string;
  label: string;
  on: boolean;
}) => (
  <label htmlFor={id} className="flex items-center gap-2 text-sm">
    <Checkbox id={id} name={name} defaultChecked={on} />
    {label}
  </label>
);

export function SiteForm({ enabled, notice }: { enabled: boolean; notice: string }) {
  const t = useTranslations('adminAi');
  return (
    <ActionForm action={saveAiSiteAction} success={t('saved')} className="grid gap-4">
      <Check id="ai-enabled" name="enabled" label={t('enabled')} on={enabled} />
      <FormField name="notice" label={t('notice')} hint={t('noticeHint')}>
        <Textarea id="f-notice" name="notice" rows={5} defaultValue={notice} />
      </FormField>
      <SubmitButton className="w-fit">{t('save')}</SubmitButton>
    </ActionForm>
  );
}

export interface ProviderValues {
  id: string;
  kind: 'ANTHROPIC' | 'OPENAI_COMPAT' | 'MOCK';
  name: string;
  baseUrl: string | null;
  hasKey: boolean;
  models: { generation: string; cheap: string; premium: string };
  capabilities: { jsonSchema?: boolean; streaming?: boolean };
  enabled: boolean;
}

const DEFAULT_MODELS = {
  ANTHROPIC: {
    generation: 'claude-sonnet-5-5',
    cheap: 'claude-haiku-5-5',
    premium: 'claude-opus-5-5',
  },
  OPENAI_COMPAT: { generation: '', cheap: '', premium: '' },
  MOCK: { generation: 'mock-generation', cheap: 'mock-cheap', premium: 'mock-premium' },
};

export function ProviderForm({ p }: { p?: ProviderValues }) {
  const t = useTranslations('adminAi');
  const [kind, setKind] = useState<ProviderValues['kind']>(p?.kind ?? 'ANTHROPIC');
  const models = p?.models ?? DEFAULT_MODELS[kind];
  const sfx = p?.id ?? 'new';
  const fid = (name: string) => `f-${name}-${sfx}`;
  return (
    <ActionForm
      action={saveAiProviderAction}
      success={t('saved')}
      resetOnSuccess={!p}
      className="grid gap-3"
    >
      {p ? <input type="hidden" name="id" value={p.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id={fid('kind')} name="kind" label={t('kind')}>
          <Select
            id={fid('kind')}
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ProviderValues['kind'])}
          >
            <option value="ANTHROPIC">Claude API (Anthropic)</option>
            <option value="OPENAI_COMPAT">{t('openaiCompat')}</option>
            <option value="MOCK">{t('mock')}</option>
          </Select>
        </FormField>
        <FormField id={fid('name')} name="name" label={t('name')} defaultValue={p?.name} required />
      </div>
      {kind !== 'MOCK' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            id={fid('baseUrl')}
            name="baseUrl"
            label={t('baseUrl')}
            type="url"
            defaultValue={p?.baseUrl ?? ''}
            hint={kind === 'ANTHROPIC' ? t('baseUrlAnthropic') : t('baseUrlCompat')}
            required={kind === 'OPENAI_COMPAT'}
          />
          <FormField
            id={fid('apiKey')}
            name="apiKey"
            label={t('apiKey')}
            type="password"
            autoComplete="off"
            placeholder={p?.hasKey ? t('keyStored') : ''}
          />
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3" key={kind}>
        <FormField
          id={fid('generation')}
          name="generation"
          label={t('modelGeneration')}
          defaultValue={models.generation}
          required
        />
        <FormField
          id={fid('cheap')}
          name="cheap"
          label={t('modelCheap')}
          defaultValue={models.cheap}
          required
        />
        <FormField
          id={fid('premium')}
          name="premium"
          label={t('modelPremium')}
          defaultValue={models.premium}
          required
        />
      </div>
      <div className="flex flex-wrap gap-4">
        {kind === 'OPENAI_COMPAT' ? (
          <>
            <Check
              id={`js-${p?.id ?? 'new'}`}
              name="jsonSchema"
              label={t('jsonSchema')}
              on={!!p?.capabilities.jsonSchema}
            />
            <Check
              id={`st-${p?.id ?? 'new'}`}
              name="streaming"
              label={t('streaming')}
              on={p?.capabilities.streaming ?? true}
            />
          </>
        ) : (
          <input type="hidden" name="streaming" value="on" />
        )}
        <Check
          id={`en-${p?.id ?? 'new'}`}
          name="enabled"
          label={t('providerEnabled')}
          on={p?.enabled ?? true}
        />
      </div>
      <SubmitButton className="w-fit">{p ? t('save') : t('addProvider')}</SubmitButton>
    </ActionForm>
  );
}

export interface FeatureValues {
  feature: 'QUIZGEN' | 'GRADING_ASSIST' | 'TUTOR';
  enabled: boolean;
  providerId: string | null;
  model: string;
  effort: string | null;
  limits: {
    userDailyTokens: number | null;
    courseMonthlyTokens: number | null;
    perMinute: number | null;
  };
}

export function FeatureForm({
  f,
  providers,
}: {
  f: FeatureValues;
  providers: { id: string; name: string }[];
}) {
  const t = useTranslations('adminAi');
  const ta = useTranslations('ai');
  const id = (k: string) => `${k}-${f.feature}`;
  return (
    <ActionForm action={saveAiFeatureAction} success={t('saved')} className="grid gap-3">
      <input type="hidden" name="feature" value={f.feature} />
      <Check id={id('en')} name="enabled" label={ta(`features.${f.feature}`)} on={f.enabled} />
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField id={`f-providerId-${f.feature}`} name="providerId" label={t('provider')}>
          <Select
            id={`f-providerId-${f.feature}`}
            name="providerId"
            defaultValue={f.providerId ?? ''}
          >
            <option value="">—</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          id={`f-model-${f.feature}`}
          name="model"
          label={t('model')}
          defaultValue={f.model}
          hint={t('modelHint')}
        />
        <FormField id={`f-effort-${f.feature}`} name="effort" label={t('effort')}>
          <Select id={`f-effort-${f.feature}`} name="effort" defaultValue={f.effort ?? ''}>
            <option value="">{t('effortDefault')}</option>
            <option value="low">{t('effortLevels.low')}</option>
            <option value="medium">{t('effortLevels.medium')}</option>
            <option value="high">{t('effortLevels.high')}</option>
          </Select>
        </FormField>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {(['perMinute', 'userDailyTokens', 'courseMonthlyTokens'] as const).map((k) => (
          <FormField key={k} id={`f-${k}-${f.feature}`} name={k} label={t(`limits.${k}`)}>
            <Input
              id={`f-${k}-${f.feature}`}
              name={k}
              type="number"
              min={0}
              defaultValue={f.limits[k] ?? ''}
              placeholder="∞"
            />
          </FormField>
        ))}
      </div>
      <Check id={id('bump')} name="bumpNotice" label={t('bumpNotice')} on={false} />
      <SubmitButton className="w-fit">{t('save')}</SubmitButton>
    </ActionForm>
  );
}

export function EmbeddingsForm({
  e,
}: {
  e: { kind: string; baseUrl: string | null; model: string; hasKey: boolean } | null;
}) {
  const t = useTranslations('adminAi');
  const [kind, setKind] = useState(e?.kind ?? '');
  return (
    <ActionForm action={saveEmbeddingsAction} success={t('saved')} className="grid gap-3">
      <FormField id="f-kind-emb" name="kind" label={t('embeddingKind')} hint={t('embeddingHint')}>
        <Select
          id="f-kind-emb"
          name="kind"
          value={kind}
          onChange={(ev) => setKind(ev.target.value)}
        >
          <option value="">{t('embeddingNone')}</option>
          <option value="OPENAI_COMPAT">{t('openaiCompat')}</option>
          <option value="MOCK">{t('mock')}</option>
        </Select>
      </FormField>
      {kind === 'OPENAI_COMPAT' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField
            id="f-baseUrl-emb"
            name="baseUrl"
            label={t('baseUrl')}
            type="url"
            defaultValue={e?.baseUrl ?? ''}
            required
          />
          <FormField
            id="f-model-emb"
            name="model"
            label={t('model')}
            defaultValue={e?.model ?? 'bge-m3'}
            required
          />
          <FormField
            id="f-apiKey-emb"
            name="apiKey"
            label={t('apiKey')}
            type="password"
            autoComplete="off"
            placeholder={e?.hasKey ? t('keyStored') : ''}
          />
        </div>
      ) : null}
      <SubmitButton className="w-fit">{t('save')}</SubmitButton>
    </ActionForm>
  );
}
