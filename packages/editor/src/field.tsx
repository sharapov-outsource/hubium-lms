'use client';

import { Field } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { RichTextEditor, type RichTextLabels } from './client.tsx';

export function useEditorLabels(): RichTextLabels {
  const t = useTranslations('editor');
  return {
    bold: t('bold'),
    italic: t('italic'),
    heading2: t('heading2'),
    heading3: t('heading3'),
    bulletList: t('bulletList'),
    orderedList: t('orderedList'),
    quote: t('quote'),
    code: t('code'),
    link: t('link'),
    linkPrompt: t('linkPrompt'),
    image: t('image'),
    video: t('video'),
    videoPrompt: t('videoPrompt'),
    videoInvalid: t('videoInvalid'),
    table: t('table'),
    formula: t('formula'),
    formulaLatex: t('formulaLatex'),
    formulaBlock: t('formulaBlock'),
    formulaPreview: t('formulaPreview'),
    insert: t('insert'),
    remove: t('remove'),
    cancel: t('cancel'),
    undo: t('undo'),
    redo: t('redo'),
  };
}

export async function uploadEditorImage(courseId: string, file: File): Promise<string> {
  const fd = new FormData();
  fd.set('file', file);
  const r = await fetch(`/api/files/editor?courseId=${encodeURIComponent(courseId)}`, {
    method: 'POST',
    body: fd,
  });
  if (!r.ok) throw new Error(await r.text());
  return ((await r.json()) as { url: string }).url;
}

/** Rich text field used by modules and core forms. */
export function EditorField({
  name,
  label,
  defaultValue,
  courseId,
  error,
  minHeight,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  courseId?: string;
  error?: string[];
  minHeight?: number;
}) {
  const labels = useEditorLabels();
  const id = `f-${name.replace(/\W/g, '-')}`;
  return (
    <Field label={label} htmlFor={id} error={error}>
      <RichTextEditor
        id={id}
        name={name}
        ariaLabel={label}
        defaultValue={defaultValue}
        labels={labels}
        minHeight={minHeight}
        uploadImage={courseId ? (f) => uploadEditorImage(courseId, f) : undefined}
      />
    </Field>
  );
}
