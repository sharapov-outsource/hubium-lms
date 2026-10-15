'use client';

import {
  ActionFailure,
  callModuleAction,
  uploadResumable,
  useFailureText,
} from '@hubium/module-sdk/form';
import { Field, Input, Progress } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

export function PackageUploader({ activityId }: { activityId: string }) {
  const t = useTranslations('mod.h5p');
  const failed = useFailureText();
  const router = useRouter();
  const [progress, setProgress] = useState<number | null>(null);
  return (
    <div className="grid gap-2">
      <Field label={t('uploadPackage')} htmlFor="h5p-file" hint={t('uploadHint')}>
        <Input
          id="h5p-file"
          type="file"
          accept=".h5p,application/zip"
          disabled={progress !== null}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setProgress(0);
            try {
              const uploadId = await uploadResumable(f, { onProgress: setProgress });
              const r = await callModuleAction(activityId, 'attachUpload', { uploadId });
              if (!r.ok) throw new ActionFailure(r.message ?? '');
              toast.success(t('uploaded'));
              router.refresh();
            } catch (err) {
              toast.error(failed(err));
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

/**
 * The content's frame: sized to the content as the player reports it, and the page's
 * results refreshed when an attempt is recorded.
 */
export function H5pFrame({ src, title, origin }: { src: string; title: string; origin: string }) {
  const router = useRouter();
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(400);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== ref.current?.contentWindow) return;
      const m = e.data as { hubium?: string; height?: unknown; result?: unknown };
      if (m?.hubium !== 'h5p') return;
      if (typeof m.height === 'number' && m.height > 0) setHeight(Math.min(m.height, 20_000));
      if (m.result) router.refresh();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, router]);
  return (
    <iframe
      ref={ref}
      src={src}
      title={title}
      className="w-full rounded-lg border border-border bg-white"
      style={{ height }}
      allow="fullscreen; autoplay"
      allowFullScreen
    />
  );
}

/** Polls while the package is being unpacked. */
export function ProcessingWatcher() {
  const router = useRouter();
  useEffect(() => {
    const poll = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(poll);
  }, [router]);
  return null;
}
