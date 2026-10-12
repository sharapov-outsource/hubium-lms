'use client';

import { callModuleAction, uploadResumable } from '@hubium/module-sdk/form';
import { Button, Field, Input, Progress } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';

export function PackageUploader({ activityId }: { activityId: string }) {
  const t = useTranslations('mod.scorm');
  const router = useRouter();
  const [progress, setProgress] = useState<number | null>(null);
  return (
    <div className="grid gap-2">
      <Field label={t('uploadPackage')} htmlFor="scorm-file" hint={t('uploadHint')}>
        <Input
          id="scorm-file"
          type="file"
          accept=".zip,application/zip"
          disabled={progress !== null}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setProgress(0);
            try {
              const uploadId = await uploadResumable(f, { onProgress: setProgress });
              const r = await callModuleAction(activityId, 'attachUpload', { uploadId });
              if (!r.ok) throw new Error(r.message);
              toast.success(t('uploaded'));
              router.refresh();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            } finally {
              setProgress(null);
            }
          }}
        />
      </Field>
      {progress !== null ? (
        <Progress value={Math.round(progress * 100)} label={`${Math.round(progress * 100)}%`} />
      ) : null}
    </div>
  );
}

export function NewAttemptButton({ activityId }: { activityId: string }) {
  const t = useTranslations('mod.scorm');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await callModuleAction(activityId, 'newAttempt', {});
          if (!r.ok) return void toast.error(r.message ?? 'Error');
          router.refresh();
        })
      }
    >
      {t('newAttempt')}
    </Button>
  );
}

/** Refreshes results when the SCO finishes, and polls while processing. */
export function ScormWatcher({ processing }: { processing: boolean }) {
  const router = useRouter();
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data && (e.data as { hubium?: string }).hubium === 'scorm-finished') {
        setTimeout(() => router.refresh(), 800);
      }
    };
    window.addEventListener('message', onMessage);
    const poll = processing ? setInterval(() => router.refresh(), 3000) : undefined;
    return () => {
      window.removeEventListener('message', onMessage);
      if (poll) clearInterval(poll);
    };
  }, [processing, router]);
  return null;
}
