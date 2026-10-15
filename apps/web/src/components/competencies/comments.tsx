import { Textarea } from '@hubium/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CommandButton } from '@/components/confirm-button';
import { commentAction, deleteCommentAction } from '@/server/actions/competencies';

/** Comments on a plan or on a person's competency, and a box to add one. */
export async function Comments({
  comments,
  target,
  path,
  me,
  canComment,
  canModerate,
}: {
  comments: {
    id: string;
    text: string;
    createdAt: Date;
    author: { id: string; name: string } | null;
  }[];
  target: Record<string, string>;
  path: string;
  me: string | null;
  canComment: boolean;
  canModerate: boolean;
}) {
  const [t, tc, format] = await Promise.all([
    getTranslations('competencies'),
    getTranslations('common'),
    getFormatter(),
  ]);
  return (
    <div className="grid gap-3">
      {comments.length ? (
        <ul className="grid gap-2 text-sm">
          {comments.map((c) => (
            <li key={c.id} className="rounded-md border border-border p-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{c.author?.name ?? t('someone')}</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {format.dateTime(c.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
                  {canModerate || (me && c.author?.id === me) ? (
                    <CommandButton
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1"
                      aria-label={`${tc('delete')}: ${c.text.slice(0, 30)}`}
                      run={deleteCommentAction.bind(null, c.id, path)}
                    >
                      ×
                    </CommandButton>
                  ) : null}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-line">{c.text}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t('noComments')}</p>
      )}
      {canComment ? (
        <ActionForm action={commentAction} resetOnSuccess className="grid gap-2">
          {Object.entries(target).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <FormField name="text" id="comment-text" label={t('addComment')}>
            <Textarea
              id="comment-text"
              name="text"
              required
              maxLength={5000}
              className="min-h-16"
            />
          </FormField>
          <div>
            <SubmitButton variant="secondary">{t('post')}</SubmitButton>
          </div>
        </ActionForm>
      ) : null}
    </div>
  );
}
