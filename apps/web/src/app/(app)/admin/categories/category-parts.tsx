'use client';

import { useConfirm } from '@hubium/module-sdk/form';
import { Button, Checkbox, Select, Textarea } from '@hubium/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@hubium/ui/dropdown';
import { toast } from '@hubium/ui/theme';
import { MoreVertical } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { categoryCommandAction, saveCategoryAction } from '@/server/actions/courses';

export function CategoryForm({
  options,
  values,
}: {
  options: { id: string; name: string; depth: number }[];
  values?: {
    id: string;
    name: string;
    parentId: string | null;
    idNumber: string | null;
    description: string;
    visible: boolean;
  };
}) {
  const t = useTranslations('categories');
  const tc = useTranslations('common');
  const router = useRouter();
  return (
    <ActionForm
      action={saveCategoryAction}
      success={tc('saved')}
      resetOnSuccess={!values}
      onSuccess={() => router.push('/admin/categories')}
      className="grid gap-3"
    >
      {values ? <input type="hidden" name="id" value={values.id} /> : null}
      <FormField name="name" label={t('name')} defaultValue={values?.name} required />
      <FormField name="parentId" label={t('parent')}>
        <Select id="f-parentId" name="parentId" defaultValue={values?.parentId ?? ''}>
          <option value="">{t('top')}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {'  '.repeat(o.depth)}
              {o.name}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField name="idNumber" label={t('idNumber')} defaultValue={values?.idNumber ?? ''} />
      <FormField name="description" label={t('description')}>
        <Textarea
          id="f-description"
          name="description"
          defaultValue={values?.description}
          className="min-h-16"
        />
      </FormField>
      <label htmlFor="cat-visible" className="flex items-center gap-2 text-sm">
        <Checkbox id="cat-visible" name="visible" defaultChecked={values?.visible ?? true} />
        {t('visible')}
      </label>
      <div className="flex gap-2">
        <SubmitButton>{values ? tc('save') : tc('create')}</SubmitButton>
        {values ? (
          <Button asChild variant="ghost">
            <Link href="/admin/categories">{tc('cancel')}</Link>
          </Button>
        ) : null}
      </div>
    </ActionForm>
  );
}

export function CategoryRowActions({ id, name }: { id: string; name: string }) {
  const tc = useTranslations('common');
  const tco = useTranslations('course');
  const tca = useTranslations('categories');
  const tp = useTranslations('permissions');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, confirmDialog] = useConfirm();
  const run = async (cmd: 'up' | 'down' | 'delete') => {
    if (cmd === 'delete' && !(await confirm(tca('deleteConfirm', { name })))) return;
    start(async () => {
      const r = await categoryCommandAction(id, cmd);
      if (!r.ok) toast.error(r.message);
      router.refresh();
    });
  };
  return (
    <>
      {confirmDialog}
      {/* not modal: the confirmation dialog it opens takes the focus and the page after it */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`${tc('actions')}: ${name}`}
            disabled={pending}
          >
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/admin/categories?edit=${id}`}>{tc('edit')}</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/course/new?category=${id}`}>{tco('new')}</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/admin/categories/${id}/permissions`}>{tp('open')}</Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void run('up')}>{tco('moveUp')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void run('down')}>{tco('moveDown')}</DropdownMenuItem>
          <DropdownMenuItem className="text-destructive" onSelect={() => void run('delete')}>
            {tc('delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
