'use client';

import { Button, Checkbox, Field, Input, Select } from '@hubium/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { ActionForm, FormField, SubmitButton, useFieldError } from '@/components/action-form';
import { saveCertificateAction } from '@/server/actions/certificates';

type Orientation = 'landscape' | 'portrait';
type Kind = 'text' | 'name' | 'course' | 'date' | 'grade' | 'code' | 'url';
const KINDS: Kind[] = ['text', 'name', 'course', 'date', 'grade', 'code', 'url'];

export interface EditorField {
  kind: Kind;
  text: string;
  x: number;
  y: number;
  size: number;
  width: number;
  align: 'left' | 'center' | 'right';
  bold: boolean;
  color: string;
}

const PAGE: Record<Orientation, [number, number]> = { landscape: [297, 210], portrait: [210, 297] };
/** 1 pt in millimetres. */
const PT = 25.4 / 72;

function FieldsError() {
  const error = useFieldError('fields');
  return error?.length ? (
    <p role="alert" className="text-sm text-destructive">
      {error.join(' ')}
    </p>
  ) : null;
}

/** The page as the PDF lays it out, near enough: the background, and the fields in place. */
function Preview({
  orientation,
  background,
  fields,
  sample,
  label,
}: {
  orientation: Orientation;
  background: string | null;
  fields: EditorField[];
  sample: Record<Exclude<Kind, 'text'>, string>;
  label: string;
}) {
  const [w, h] = PAGE[orientation];
  const u = (mm: number) => `${(mm / w) * 100}cqw`;
  return (
    <figure className="grid gap-1">
      <div
        className="relative overflow-hidden rounded-md border border-border bg-white text-[#1f2937] [container-type:inline-size]"
        style={{ aspectRatio: `${w} / ${h}`, fontFamily: 'Roboto, Arial, sans-serif' }}
        aria-hidden="true"
      >
        {background ? (
          // biome-ignore lint/performance/noImgElement: a preview of the uploaded picture
          <img src={background} alt="" className="absolute inset-0 size-full object-cover" />
        ) : null}
        {fields.map((f, i) => {
          const text = f.kind === 'text' ? f.text : `${f.text}${sample[f.kind]}`;
          const shift = f.align === 'center' ? '-50%' : f.align === 'right' ? '-100%' : '0';
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: fields have no ids; order is identity
              key={i}
              className="absolute whitespace-pre-wrap leading-[1.2]"
              style={{
                left: u(f.x),
                top: u(f.y),
                transform: `translateX(${shift})`,
                width: f.width ? u(f.width) : undefined,
                whiteSpace: f.width ? 'pre-wrap' : 'pre',
                textAlign: f.align,
                fontSize: u(f.size * PT),
                fontWeight: f.bold ? 700 : 400,
                color: f.color,
              }}
            >
              {text}
            </div>
          );
        })}
      </div>
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  );
}

export function CertificateEditor({
  courseId,
  certificate,
  defaults,
  sample,
  backgroundUrl,
}: {
  courseId: string;
  certificate?: {
    id: string;
    name: string;
    orientation: Orientation;
    fields: EditorField[];
    onCompletion: boolean;
  };
  /** The starting layout for each orientation. */
  defaults: Record<Orientation, EditorField[]>;
  /** What the preview fills in. */
  sample: Record<Exclude<Kind, 'text'>, string>;
  /** The current background, if any. */
  backgroundUrl: string | null;
}) {
  const t = useTranslations('certificates');
  const tc = useTranslations('common');
  const router = useRouter();
  const [orientation, setOrientation] = useState<Orientation>(
    certificate?.orientation ?? 'landscape',
  );
  const [fields, setFields] = useState<EditorField[]>(
    certificate?.fields ?? defaults[certificate?.orientation ?? 'landscape'],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const [remove, setRemove] = useState(false);
  useEffect(() => () => void (chosen && URL.revokeObjectURL(chosen)), [chosen]);
  const background = chosen ?? (remove ? null : backgroundUrl);
  const set = (i: number, patch: Partial<EditorField>) =>
    setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const [w, h] = PAGE[orientation];
  return (
    <ActionForm
      action={saveCertificateAction}
      success={tc('saved')}
      onSuccess={(r: { id: string }) => {
        router.push(`/course/${courseId}/certificates/${r.id}`);
        router.refresh();
      }}
      className="grid gap-4"
    >
      {certificate ? <input type="hidden" name="id" value={certificate.id} /> : null}
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="fields" value={JSON.stringify(fields)} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="name"
          id="cert-name"
          label={t('name')}
          defaultValue={certificate?.name}
          required
          maxLength={255}
        />
        <Field label={t('orientation')} htmlFor="cert-orientation">
          <Select
            id="cert-orientation"
            name="orientation"
            value={orientation}
            onChange={(e) => setOrientation(e.target.value as Orientation)}
          >
            <option value="landscape">{t('orientations.landscape')}</option>
            <option value="portrait">{t('orientations.portrait')}</option>
          </Select>
        </Field>
      </div>
      <label htmlFor="cert-oncompletion" className="flex items-center gap-2 text-sm">
        <Checkbox
          id="cert-oncompletion"
          name="onCompletion"
          defaultChecked={certificate?.onCompletion ?? true}
        />
        {t('onCompletion')}
      </label>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <FormField
          name="background"
          id="cert-background"
          label={t('background')}
          hint={t('backgroundHint')}
          type="file"
          accept="image/png,image/jpeg,.png,.jpg,.jpeg"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            setChosen(f ? URL.createObjectURL(f) : null);
          }}
        />
        {backgroundUrl ? (
          <label htmlFor="cert-nobg" className="flex items-center gap-2 pb-2 text-sm">
            <Checkbox
              id="cert-nobg"
              name="removeBackground"
              checked={remove}
              onChange={(e) => setRemove(e.target.checked)}
            />
            {t('removeBackground')}
          </label>
        ) : null}
      </div>

      <Preview
        orientation={orientation}
        background={background}
        fields={fields}
        sample={sample}
        label={t('previewNote', { w, h })}
      />

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">{t('fields')}</legend>
        <p className="text-xs text-muted-foreground">{t('fieldsHint')}</p>
        <FieldsError />
        {fields.map((f, i) => {
          const n = i + 1;
          const id = `cf-${i}`;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: fields have no ids; order is identity
            <div key={i} className="grid gap-2 rounded-md border border-border p-3">
              <div className="grid gap-2 sm:grid-cols-[12rem_1fr_auto]">
                <Field label={t('field.kind', { n })} htmlFor={`${id}-kind`}>
                  <Select
                    id={`${id}-kind`}
                    value={f.kind}
                    onChange={(e) => set(i, { kind: e.target.value as Kind })}
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(`kinds.${k}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label={f.kind === 'text' ? t('field.text') : t('field.label')}
                  htmlFor={`${id}-text`}
                >
                  <Input
                    id={`${id}-text`}
                    value={f.text}
                    maxLength={500}
                    onChange={(e) => set(i, { text: e.target.value })}
                  />
                </Field>
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('field.remove', { n })}
                    onClick={() => setFields(fields.filter((_, j) => j !== i))}
                  >
                    {tc('delete')}
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                {(
                  [
                    ['x', 0, w],
                    ['y', 0, h],
                    ['size', 4, 144],
                    ['width', 0, w],
                  ] as const
                ).map(([key, min, max]) => (
                  <Field key={key} label={t(`field.${key}`)} htmlFor={`${id}-${key}`}>
                    <Input
                      id={`${id}-${key}`}
                      type="number"
                      min={min}
                      max={max}
                      step={key === 'size' ? 1 : 0.5}
                      value={f[key]}
                      onChange={(e) => set(i, { [key]: num(e.target.value) })}
                    />
                  </Field>
                ))}
                <Field label={t('field.align')} htmlFor={`${id}-align`}>
                  <Select
                    id={`${id}-align`}
                    value={f.align}
                    onChange={(e) => set(i, { align: e.target.value as EditorField['align'] })}
                  >
                    <option value="left">{t('align.left')}</option>
                    <option value="center">{t('align.center')}</option>
                    <option value="right">{t('align.right')}</option>
                  </Select>
                </Field>
                <Field label={t('field.color')} htmlFor={`${id}-color`}>
                  <Input
                    id={`${id}-color`}
                    type="color"
                    value={f.color}
                    onChange={(e) => set(i, { color: e.target.value })}
                    className="h-9 p-1"
                  />
                </Field>
                <label htmlFor={`${id}-bold`} className="flex items-end gap-2 pb-2 text-sm">
                  <Checkbox
                    id={`${id}-bold`}
                    checked={f.bold}
                    onChange={(e) => set(i, { bold: e.target.checked })}
                  />
                  {t('field.bold')}
                </label>
              </div>
            </div>
          );
        })}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={fields.length >= 30}
            onClick={() =>
              setFields([
                ...fields,
                {
                  kind: 'text',
                  text: '',
                  x: w / 2,
                  y: h / 2,
                  size: 14,
                  width: 0,
                  align: 'center',
                  bold: false,
                  color: '#1f2937',
                },
              ])
            }
          >
            {t('addField')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setFields(defaults[orientation])}>
            {t('resetLayout')}
          </Button>
        </div>
      </fieldset>
      <div>
        <SubmitButton>{tc('save')}</SubmitButton>
      </div>
    </ActionForm>
  );
}
