'use client';

import { Alert, Button, Select } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { createNodeAction, updateNodeAction } from '@/server/actions/nodes';

/** What to run on the node's server, with the code (shown once). */
export function InstallNotice({ code, hub }: { code: string; hub: string }) {
  const t = useTranslations('nodes');
  const command = `sudo bash install-hubium.sh --node --hub ${hub} --code ${code}`;
  return (
    <Alert variant="success" className="grid gap-2">
      <strong>{t('codeTitle')}</strong>
      <span className="text-sm">{t('codeHint')}</span>
      <code className="break-all rounded bg-muted p-2 font-mono text-xs" data-testid="node-install">
        {command}
      </code>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-fit"
        onClick={() => {
          void navigator.clipboard?.writeText(command);
          toast.success(t('copied'));
        }}
      >
        {t('copy')}
      </Button>
    </Alert>
  );
}

function CategoriesField({
  categories,
  selected,
}: {
  categories: { id: string; name: string }[];
  selected: string[];
}) {
  const t = useTranslations('nodes');
  return (
    <div className="grid gap-1.5">
      <label htmlFor="node-categories" className="text-sm font-medium">
        {t('categories')}
      </label>
      <Select
        id="node-categories"
        name="categoryIds"
        multiple
        defaultValue={selected}
        className="h-32"
        aria-describedby="node-categories-hint"
      >
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      <p id="node-categories-hint" className="text-sm text-muted-foreground">
        {t('categoriesHint')}
      </p>
    </div>
  );
}

export function NodeCreateForm({
  categories,
  hub,
}: {
  categories: { id: string; name: string }[];
  hub: string;
}) {
  const t = useTranslations('nodes');
  const router = useRouter();
  const [code, setCode] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  return (
    <div className="grid gap-4">
      <ActionForm
        key={round}
        action={createNodeAction}
        onSuccess={(r) => {
          setCode(r.code);
          setRound((n) => n + 1);
          router.refresh();
        }}
        className="grid gap-4"
      >
        <FormField name="name" label={t('name')} required maxLength={200} hint={t('nameHint')} />
        <CategoriesField categories={categories} selected={[]} />
        <SubmitButton className="w-fit">{t('add')}</SubmitButton>
      </ActionForm>
      {code ? <InstallNotice code={code} hub={hub} /> : null}
    </div>
  );
}

export function NodeEditForm({
  node,
  categories,
}: {
  node: { id: string; name: string; categoryIds: string[] };
  categories: { id: string; name: string }[];
}) {
  const t = useTranslations('nodes');
  const tc = useTranslations('common');
  return (
    <ActionForm action={updateNodeAction} success={tc('saved')} className="grid gap-4">
      <input type="hidden" name="id" value={node.id} />
      <FormField name="name" label={t('name')} required maxLength={200} defaultValue={node.name} />
      <CategoriesField categories={categories} selected={node.categoryIds} />
      <SubmitButton className="w-fit">{tc('save')}</SubmitButton>
    </ActionForm>
  );
}
