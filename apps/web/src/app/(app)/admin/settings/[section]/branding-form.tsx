'use client';

import { Alert, Checkbox, Field, Input } from '@hubium/ui';
import { generateAccentPalette } from '@hubium/ui/palette';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { saveBrandingAction } from '@/server/actions/admin';

export function BrandingForm({ accent, hasLogo }: { accent: string; hasLogo: boolean }) {
  const t = useTranslations('admin.settings');
  const tc = useTranslations('common');
  const [color, setColor] = useState(accent);
  const valid = /^#[0-9a-fA-F]{6}$/.test(color);
  const palette = useMemo(() => (valid ? generateAccentPalette(color) : null), [color, valid]);
  return (
    <ActionForm
      action={saveBrandingAction}
      success={tc('saved')}
      className="grid max-w-xl gap-5"
      onSuccess={() => window.location.reload()}
    >
      <Field label={t('accent')} htmlFor="accent" hint={t('accentHint')}>
        <div className="flex items-center gap-3">
          <input
            type="color"
            aria-label={t('accent')}
            value={valid ? color : '#4f46e5'}
            onChange={(e) => setColor(e.target.value)}
            className="h-9 w-12 cursor-pointer rounded border border-input bg-background"
          />
          <Input
            id="accent"
            name="accent"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="w-32 font-mono"
          />
        </div>
      </Field>
      {palette?.adjusted ? (
        <Alert variant="warning">
          {t('accentAdjusted', { ratio: palette.originalContrast.toFixed(2) })}
        </Alert>
      ) : null}
      {palette ? (
        <div className="grid gap-2">
          <p className="text-sm font-medium">{t('preview')}</p>
          <div className="flex flex-wrap gap-3">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-white p-3">
              <span
                className="rounded-md px-3 py-1.5 text-sm font-medium"
                style={{ background: palette.light.accent, color: palette.light.accentForeground }}
              >
                {tc('save')}
              </span>
              <span className="text-sm underline" style={{ color: palette.light.accent }}>
                {t('sampleLink')}
              </span>
            </div>
            <div
              className="flex items-center gap-3 rounded-lg border border-border p-3"
              style={{ background: '#111318' }}
            >
              <span
                className="rounded-md px-3 py-1.5 text-sm font-medium"
                style={{ background: palette.dark.accent, color: palette.dark.accentForeground }}
              >
                {tc('save')}
              </span>
              <span className="text-sm underline" style={{ color: palette.dark.accent }}>
                {t('sampleLink')}
              </span>
            </div>
          </div>
        </div>
      ) : null}
      <FormField
        name="logo"
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/webp"
        label={t('logo')}
        hint={t('logoHint')}
      />
      {hasLogo ? (
        <div className="flex items-center gap-4">
          {/* biome-ignore lint/performance/noImgElement: branding route */}
          <img
            src="/branding/logo"
            alt=""
            className="h-10 max-w-48 rounded border border-border bg-white object-contain p-1"
          />
          <label htmlFor="removeLogo" className="flex items-center gap-2 text-sm">
            <Checkbox id="removeLogo" name="removeLogo" />
            {t('removeLogo')}
          </label>
        </div>
      ) : null}
      <div>
        <SubmitButton>{tc('save')}</SubmitButton>
      </div>
    </ActionForm>
  );
}
