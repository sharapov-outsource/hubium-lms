'use client';

import type { ActionResult } from '@hubium/core/operation';
import { Button, Textarea } from '@hubium/ui';
import { Dialog, DialogContent, DialogTrigger } from '@hubium/ui/dialog';
import { useId, useState } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';

/** Revokes something given to a person (a badge, a certificate) with a reason anyone checking it sees. */
export function RevokeButton({
  action,
  hidden,
  name,
  label,
  reasonLabel,
  done,
}: {
  action: (fd: FormData) => Promise<ActionResult<unknown>>;
  /** Hidden form fields: what is revoked, and where. */
  hidden: Record<string, string>;
  /** Whose it is. */
  name: string;
  label: string;
  reasonLabel: string;
  done: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={`${label}: ${name}`}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent title={`${label}: ${name}`}>
        <ActionForm
          action={action}
          success={done}
          onSuccess={() => setOpen(false)}
          className="grid gap-3"
        >
          {Object.entries(hidden).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <FormField name="reason" label={reasonLabel} id={`${id}-reason`}>
            <Textarea id={`${id}-reason`} name="reason" required maxLength={500} />
          </FormField>
          <div>
            <SubmitButton variant="destructive">{label}</SubmitButton>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
