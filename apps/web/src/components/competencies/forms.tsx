'use client';

import { Checkbox, Field, Input, Select, Textarea } from '@hubium/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import {
  saveCompetencyAction,
  saveFrameworkAction,
  setRuleAction,
} from '@/server/actions/competencies';

export interface ScaleOption {
  id: string;
  name: string;
  items: string[];
}

const TAXONOMIES = [
  'behaviour',
  'competency',
  'concept',
  'domain',
  'indicator',
  'level',
  'outcome',
  'practice',
  'proficiency',
  'skill',
  'value',
] as const;

/** A scale and its configuration: the value given on completion, and the proficient ones. */
function ScaleFields({
  scales,
  scaleId,
  config,
  allowNew,
  onScale,
}: {
  scales: ScaleOption[];
  scaleId: string;
  config?: { default: number; proficient: number[] } | null;
  allowNew?: boolean;
  onScale: (id: string) => void;
}) {
  const t = useTranslations('competencies');
  const id = useId();
  const scale = scales.find((s) => s.id === scaleId);
  const [def, setDef] = useState(config?.default ?? scale?.items.length ?? 1);
  const [proficient, setProficient] = useState<number[]>(
    config?.proficient ?? (scale ? [scale.items.length] : []),
  );
  return (
    <div className="grid gap-3 rounded-md border border-border p-3">
      <Field label={t('scale')} htmlFor={`${id}-scale`}>
        <Select
          id={`${id}-scale`}
          name="scaleId"
          value={scaleId}
          onChange={(e) => {
            const next = scales.find((s) => s.id === e.target.value);
            onScale(e.target.value);
            if (next) {
              setDef(next.items.length);
              setProficient([next.items.length]);
            }
          }}
        >
          {allowNew ? <option value="new">{t('newScale')}</option> : null}
          {scales.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.items.join(', ')})
            </option>
          ))}
        </Select>
      </Field>
      {scale ? (
        <>
          <Field label={t('scaleDefault')} htmlFor={`${id}-def`}>
            <Select
              id={`${id}-def`}
              name="scaleDefault"
              value={String(def)}
              onChange={(e) => {
                const v = Number(e.target.value);
                setDef(v);
                if (!proficient.includes(v)) setProficient([...proficient, v]);
              }}
            >
              {scale.items.map((item, i) => (
                <option key={item} value={String(i + 1)}>
                  {item}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="grid gap-1 text-sm">
            <legend className="mb-1 text-sm font-medium">{t('proficientValues')}</legend>
            {scale.items.map((item, i) => (
              <label key={item} htmlFor={`${id}-p${i}`} className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-p${i}`}
                  name="proficient"
                  value={String(i + 1)}
                  checked={proficient.includes(i + 1)}
                  disabled={def === i + 1}
                  onChange={(e) =>
                    setProficient(
                      e.target.checked
                        ? [...proficient, i + 1]
                        : proficient.filter((x) => x !== i + 1),
                    )
                  }
                />
                {item}
              </label>
            ))}
            {/* the default value is always proficient; a disabled box is not submitted */}
            <input type="hidden" name="proficient" value={String(def)} />
          </fieldset>
        </>
      ) : null}
    </div>
  );
}

export function FrameworkForm({
  framework,
  scales,
}: {
  framework?: {
    id: string;
    shortName: string;
    idNumber: string;
    description: string;
    scaleId: string;
    scaleConfig: { default: number; proficient: number[] };
    taxonomies: string[];
    visible: boolean;
  };
  scales: ScaleOption[];
}) {
  const t = useTranslations('competencies');
  const tc = useTranslations('common');
  const router = useRouter();
  const [scaleId, setScaleId] = useState(framework?.scaleId ?? scales[0]?.id ?? 'new');
  const [levels, setLevels] = useState<string[]>(
    framework?.taxonomies.length ? framework.taxonomies : ['competency', 'competency'],
  );
  return (
    <ActionForm
      action={saveFrameworkAction}
      success={tc('saved')}
      onSuccess={(r: { id: string }) => {
        if (!framework) router.push(`/admin/competencies/${r.id}`);
        router.refresh();
      }}
      className="grid gap-4"
    >
      {framework ? <input type="hidden" name="id" value={framework.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="shortName"
          id="fw-name"
          label={t('name')}
          defaultValue={framework?.shortName}
          required
        />
        <FormField
          name="idNumber"
          id="fw-idnumber"
          label={t('idNumber')}
          defaultValue={framework?.idNumber}
          required
        />
      </div>
      <FormField name="description" id="fw-description" label={t('description')}>
        <Textarea id="fw-description" name="description" defaultValue={framework?.description} />
      </FormField>
      <ScaleFields
        key={scaleId}
        scales={scales}
        scaleId={scaleId}
        config={scaleId === framework?.scaleId ? framework.scaleConfig : null}
        allowNew={!framework}
        onScale={setScaleId}
      />
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('taxonomies')}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {levels.map((level, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: levels are positions
            <Field key={i} label={t('level', { n: i + 1 })} htmlFor={`fw-level-${i}`}>
              <Select
                id={`fw-level-${i}`}
                name="taxonomy"
                value={level}
                onChange={(e) => setLevels(levels.map((l, j) => (j === i ? e.target.value : l)))}
              >
                {TAXONOMIES.map((x) => (
                  <option key={x} value={x}>
                    {t(`taxonomy.${x}`)}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
        <div className="flex gap-2 text-sm">
          {levels.length < 6 ? (
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => setLevels([...levels, 'competency'])}
            >
              {t('addLevel')}
            </button>
          ) : null}
          {levels.length > 1 ? (
            <button
              type="button"
              className="text-muted-foreground hover:underline"
              onClick={() => setLevels(levels.slice(0, -1))}
            >
              {t('removeLevel')}
            </button>
          ) : null}
        </div>
      </fieldset>
      <label htmlFor="fw-visible" className="flex items-center gap-2 text-sm">
        <Checkbox id="fw-visible" name="visible" defaultChecked={framework?.visible ?? true} />
        {t('visible')}
      </label>
      <div>
        <SubmitButton>{tc('save')}</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function CompetencyForm({
  frameworkId,
  parentId,
  competency,
  scales,
  idPrefix,
}: {
  frameworkId: string;
  parentId?: string | null;
  competency?: {
    id: string;
    shortName: string;
    idNumber: string;
    description: string;
    scaleId: string | null;
    scaleConfig: { default: number; proficient: number[] } | null;
  };
  scales: ScaleOption[];
  /** Field ids: two of these forms may share a page. */
  idPrefix: string;
}) {
  const t = useTranslations('competencies');
  const tc = useTranslations('common');
  const router = useRouter();
  const [own, setOwn] = useState(!!competency?.scaleId);
  const [scaleId, setScaleId] = useState(competency?.scaleId ?? scales[0]?.id ?? '');
  return (
    <ActionForm
      action={saveCompetencyAction}
      success={tc('saved')}
      resetOnSuccess={!competency}
      onSuccess={() => router.refresh()}
      className="grid gap-3"
    >
      <input type="hidden" name="frameworkId" value={frameworkId} />
      {competency ? <input type="hidden" name="id" value={competency.id} /> : null}
      {parentId ? <input type="hidden" name="parentId" value={parentId} /> : null}
      <FormField
        name="shortName"
        id={`${idPrefix}-name`}
        label={t('name')}
        defaultValue={competency?.shortName}
        required
      />
      <FormField
        name="idNumber"
        id={`${idPrefix}-idnumber`}
        label={t('idNumber')}
        defaultValue={competency?.idNumber}
        required
      />
      <FormField name="description" id={`${idPrefix}-description`} label={t('description')}>
        <Textarea
          id={`${idPrefix}-description`}
          name="description"
          defaultValue={competency?.description}
        />
      </FormField>
      {competency ? (
        <>
          <label htmlFor={`${idPrefix}-own`} className="flex items-center gap-2 text-sm">
            <Checkbox
              id={`${idPrefix}-own`}
              checked={own}
              onChange={(e) => setOwn(e.target.checked)}
            />
            {t('ownScale')}
          </label>
          {own ? (
            <ScaleFields
              key={scaleId}
              scales={scales}
              scaleId={scaleId}
              config={scaleId === competency.scaleId ? competency.scaleConfig : null}
              onScale={setScaleId}
            />
          ) : null}
        </>
      ) : null}
      <div>
        <SubmitButton>{competency ? tc('save') : tc('add')}</SubmitButton>
      </div>
    </ActionForm>
  );
}

/** How a competency follows its children. */
export function RuleForm({
  competencyId,
  rule,
  kids,
}: {
  competencyId: string;
  rule: {
    type: 'ALL' | 'POINTS' | null;
    outcome: string;
    config: {
      points: number;
      children: { id: string; points: number; required: boolean }[];
    } | null;
  };
  /** The competency's children. */
  kids: { id: string; shortName: string }[];
}) {
  const t = useTranslations('competencies');
  const tc = useTranslations('common');
  const router = useRouter();
  const [type, setType] = useState(rule.type ?? '');
  const cfg = (id: string) => rule.config?.children.find((c) => c.id === id);
  return (
    <ActionForm
      action={setRuleAction}
      success={tc('saved')}
      onSuccess={() => router.refresh()}
      className="grid gap-3"
    >
      <input type="hidden" name="id" value={competencyId} />
      <input type="hidden" name="children" value={kids.map((c) => c.id).join(',')} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ruleType')} htmlFor="rule-type">
          <Select
            id="rule-type"
            name="ruleType"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="">{t('rules.none')}</option>
            <option value="ALL">{t('rules.ALL')}</option>
            <option value="POINTS">{t('rules.POINTS')}</option>
          </Select>
        </Field>
        {type ? (
          <Field label={t('ruleOutcome')} htmlFor="rule-outcome">
            <Select id="rule-outcome" name="ruleOutcome" defaultValue={rule.outcome}>
              {(['NONE', 'EVIDENCE', 'RECOMMEND', 'COMPLETE'] as const).map((o) => (
                <option key={o} value={o}>
                  {t(`outcomes.${o}`)}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
      {type === 'POINTS' ? (
        <div className="grid gap-2">
          <FormField
            name="points"
            id="rule-points"
            type="number"
            min={1}
            label={t('pointsNeeded')}
            defaultValue={rule.config?.points ?? 1}
            className="w-40"
          />
          <table className="text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 font-normal">{t('child')}</th>
                <th className="py-1 font-normal">{t('points')}</th>
                <th className="py-1 font-normal">{t('required')}</th>
              </tr>
            </thead>
            <tbody>
              {kids.map((c) => (
                <tr key={c.id}>
                  <td className="py-1 pr-2">{c.shortName}</td>
                  <td className="py-1 pr-2">
                    <Input
                      type="number"
                      min={0}
                      name={`points-${c.id}`}
                      aria-label={`${t('points')}: ${c.shortName}`}
                      defaultValue={cfg(c.id)?.points ?? 1}
                      className="w-24"
                    />
                  </td>
                  <td className="py-1">
                    <Checkbox
                      name={`required-${c.id}`}
                      aria-label={`${t('required')}: ${c.shortName}`}
                      defaultChecked={cfg(c.id)?.required}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div>
        <SubmitButton>{tc('save')}</SubmitButton>
      </div>
    </ActionForm>
  );
}
