'use client';

import { toast } from '@hubium/ui/theme';
import { Check, Circle, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { overrideCompletionAction } from '@/server/actions/courses';

export function CompletionCell({
  courseId,
  activityId,
  userId,
  state,
  label,
  canOverride,
  overrideLabel,
}: {
  courseId: string;
  activityId: string;
  userId: string;
  state: string;
  label: string;
  canOverride: boolean;
  /** What pressing the cell does, said after its state. */
  overrideLabel: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const done = state !== 'INCOMPLETE';
  const icon =
    state === 'COMPLETE_FAIL' ? (
      <X className="size-4 text-destructive" />
    ) : done ? (
      <Check className="size-4 text-success" />
    ) : (
      <Circle className="size-4 text-muted-foreground/50" />
    );
  if (!canOverride)
    return (
      <span title={label} aria-label={label} role="img">
        {icon}
      </span>
    );
  return (
    <button
      type="button"
      title={`${label}. ${overrideLabel}`}
      aria-label={`${label}. ${overrideLabel}`}
      disabled={pending}
      className="rounded p-1 hover:bg-muted"
      onClick={() =>
        start(async () => {
          const r = await overrideCompletionAction(
            courseId,
            activityId,
            userId,
            done ? 'INCOMPLETE' : 'COMPLETE',
          );
          if (!r.ok) toast.error(r.message);
          router.refresh();
        })
      }
    >
      {icon}
    </button>
  );
}
