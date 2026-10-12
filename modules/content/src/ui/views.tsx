import { RichText } from '@hubium/editor/client';
import type { ViewProps } from '@hubium/module-sdk/ui';
import { Button, EmptyState } from '@hubium/ui';
import { Download, ExternalLink, FileIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { embedFor } from '../server.ts';

export function PageView({ activity }: ViewProps<{ content: string }>) {
  return <RichText html={activity.settings.content} className="max-w-3xl" />;
}

export async function UrlView({
  activity,
}: ViewProps<{ url: string; display: 'link' | 'newtab' | 'embed' }>) {
  const t = await getTranslations('mod.url');
  const { url, display } = activity.settings;
  const embed = display === 'embed' ? embedFor(url) : null;
  if (embed) {
    return (
      <div className="aspect-video w-full max-w-4xl overflow-hidden rounded-lg border border-border bg-black">
        <iframe
          src={embed}
          title={activity.name}
          className="h-full w-full"
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          loading="lazy"
        />
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <Button asChild size="lg" className="w-fit">
        <a
          href={url}
          target={display === 'newtab' ? '_blank' : undefined}
          rel="noopener noreferrer"
        >
          <ExternalLink />
          {t('open')}
        </a>
      </Button>
      <p className="break-all text-sm text-muted-foreground">{url}</p>
    </div>
  );
}

export async function FileView({ activity, ctx }: ViewProps<{ display: 'list' | 'download' }>) {
  const t = await getTranslations('mod.file');
  const files = await ctx.files.list(activity.id, 'content');
  if (!files.length) return <EmptyState icon={<FileIcon />} title={t('empty')} />;
  return (
    <ul className="grid max-w-2xl gap-2">
      {files.map((f) => (
        <li
          key={f.id}
          className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
        >
          <a href={f.url} className="flex min-w-0 items-center gap-3 font-medium hover:underline">
            <FileIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{f.name}</span>
          </a>
          <span className="flex items-center gap-3 text-xs text-muted-foreground">
            {formatSize(Number(f.size))}
            <a
              href={`${f.url}?download`}
              aria-label={`Download ${f.name}`}
              className="hover:text-foreground"
            >
              <Download className="size-4" />
            </a>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function LabelInline({ activity }: { activity: { settings: { content: string } } }) {
  return <RichText html={activity.settings.content} />;
}
