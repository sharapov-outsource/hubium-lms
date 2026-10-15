'use client';

import { callModuleAction, useFailureText } from '@hubium/module-sdk/form';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/** Runs an assignment action, reports the outcome and refreshes the page. */
export function useAction(activityId: string) {
  const failed = useFailureText();
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (
    action: string,
    input: Record<string, unknown>,
    files?: File[],
    done?: () => void,
    okMsg?: string,
  ) =>
    start(async () => {
      const r = await callModuleAction(
        activityId,
        action,
        input,
        files?.length ? { list: files } : undefined,
      );
      if (!r.ok) {
        toast.error(failed(r));
        return;
      }
      if (okMsg) toast.success(okMsg);
      done?.();
      router.refresh();
    });
  return { pending, run };
}
