'use client';

import type { ActionResult } from '@hubium/core/operation';
import { Button, type ButtonProps } from '@hubium/ui';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@hubium/ui/dialog';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState, useTransition } from 'react';

/** Runs a server action on click, optionally behind a confirmation dialog. */
export function CommandButton<T>({
  run,
  confirm,
  success,
  onDone,
  children,
  ...props
}: Omit<ButtonProps, 'onClick'> & {
  run: () => Promise<ActionResult<T> | undefined>;
  confirm?: ReactNode;
  success?: string;
  /** what the action answered, when it succeeded */
  onDone?: (data: T) => void;
  children: ReactNode;
}) {
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const exec = () =>
    start(async () => {
      const r = await run();
      setOpen(false);
      if (r && !r.ok) toast.error(r.message);
      else {
        if (r) onDone?.(r.data);
        if (success) toast.success(success);
        router.refresh();
      }
    });
  if (!confirm) {
    return (
      <Button {...props} disabled={pending || props.disabled} onClick={exec}>
        {children}
      </Button>
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button {...props}>{children}</Button>
      </DialogTrigger>
      <DialogContent title={tc('confirm')} description={confirm} closeLabel={tc('close')}>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{tc('cancel')}</Button>
          </DialogClose>
          <Button
            variant={props.variant === 'destructive' ? 'destructive' : 'primary'}
            disabled={pending}
            onClick={exec}
          >
            {tc('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
