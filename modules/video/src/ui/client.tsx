'use client';

import { callModuleAction, uploadResumable } from '@hubium/module-sdk/form';
import { Button, Field, Input, Progress, Select } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import {
  MediaCaptionsButton,
  MediaControlBar,
  MediaController,
  MediaFullscreenButton,
  MediaLoadingIndicator,
  MediaMuteButton,
  MediaPlayButton,
  MediaPlaybackRateButton,
  MediaPreviewThumbnail,
  MediaPreviewTimeDisplay,
  MediaSeekBackwardButton,
  MediaSeekForwardButton,
  MediaTimeDisplay,
  MediaTimeRange,
  MediaVolumeRange,
} from 'media-chrome/react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition } from 'react';
import { type EmbedProvider, type Interval, mergeIntervals } from '../media.ts';

// ── watch tracking ───────────────────────────────────────────────────────────

const HEARTBEAT_MS = 15_000;

/** Furthest point reached by continuous watching from the start. */
function furthestFrom(intervals: Interval[]): number {
  const first = mergeIntervals(intervals)[0];
  return first && first[0] <= 1 ? first[1] : 0;
}

/**
 * Collects watched intervals from playback time updates, sends them every 15 s and on
 * page hide (sendBeacon), and optionally blocks seeking past the furthest watched point.
 */
function useWatchTracker(
  activityId: string,
  opts: { initial: Interval[]; noSeekAhead: boolean; onPercent?: (p: number) => void },
) {
  const pending = useRef<Interval[]>([]);
  const cur = useRef<Interval | null>(null);
  const last = useRef<number | null>(null);
  const furthest = useRef(furthestFrom(opts.initial));
  const duration = useRef(0);
  const position = useRef(0);
  const onPercent = useRef(opts.onPercent);
  onPercent.current = opts.onPercent;

  const take = (): Interval[] => {
    const c = cur.current;
    if (c && c[1] > c[0]) {
      pending.current.push([c[0], c[1]]);
      cur.current = [c[1], c[1]];
    }
    const out = mergeIntervals(pending.current);
    pending.current = [];
    return out;
  };

  const payload = () => ({
    intervals: take(),
    duration: duration.current,
    position: position.current,
  });

  const flush = async () => {
    const input = payload();
    if (!input.intervals.length) return;
    const r = await callModuleAction<{ percent: number }>(activityId, 'progress', input);
    if (r.ok && r.data) onPercent.current?.(r.data.percent);
    else pending.current.push(...input.intervals);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: closures read refs only
  useEffect(() => {
    const t = setInterval(() => void flush(), HEARTBEAT_MS);
    const beacon = () => {
      const input = payload();
      if (!input.intervals.length) return;
      const fd = new FormData();
      fd.set('activityId', activityId);
      fd.set('action', 'progress');
      fd.set('input', JSON.stringify(input));
      navigator.sendBeacon('/api/mod/action', fd);
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') beacon();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', beacon);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', beacon);
      beacon();
    };
  }, [activityId]);

  return {
    furthest,
    setDuration(d: number) {
      if (Number.isFinite(d) && d > 0) duration.current = d;
    },
    /** Feed the current playback time; returns a time to jump back to if seeking is blocked. */
    onTime(t: number): number | null {
      position.current = t;
      const prev = last.current;
      if (prev !== null && t >= prev && t - prev <= 2.5) {
        if (cur.current) cur.current[1] = t;
        else cur.current = [prev, t];
        if (cur.current[0] <= furthest.current + 1)
          furthest.current = Math.max(furthest.current, t);
      } else {
        if (cur.current && cur.current[1] > cur.current[0]) pending.current.push([...cur.current]);
        if (opts.noSeekAhead && t > furthest.current + 1) {
          last.current = furthest.current;
          cur.current = null;
          return furthest.current;
        }
        cur.current = [t, t];
      }
      last.current = t;
      return null;
    },
    flush,
  };
}

// ── uploaded video (HLS) ─────────────────────────────────────────────────────

export function HlsPlayer({
  activityId,
  src,
  poster,
  sprite,
  captions,
  noSeekAhead,
  initial,
  initialPosition,
  title,
}: {
  activityId: string;
  src: string;
  poster?: string;
  sprite?: string;
  captions: { lang: string; label: string; url: string }[];
  noSeekAhead: boolean;
  initial: Interval[];
  initialPosition: number;
  title: string;
}) {
  const t = useTranslations('mod.video');
  const video = useRef<HTMLVideoElement>(null);
  const [percent, setPercent] = useState<number | null>(null);
  // media-chrome upgrades its custom elements on the client; render it there only
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const tracker = useWatchTracker(activityId, { initial, noSeekAhead, onPercent: setPercent });

  useEffect(() => {
    if (!mounted) return;
    const el = video.current;
    if (!el) return;
    let destroy = () => {};
    let cancelled = false;
    void (async () => {
      if (el.canPlayType('application/vnd.apple.mpegurl')) {
        el.src = src;
        return;
      }
      const { default: Hls } = await import('hls.js');
      if (cancelled) return;
      if (!Hls.isSupported()) {
        el.src = src;
        return;
      }
      const hls = new Hls({ capLevelToPlayerSize: true });
      hls.loadSource(src);
      hls.attachMedia(el);
      destroy = () => hls.destroy();
    })();
    return () => {
      cancelled = true;
      destroy();
    };
  }, [src, mounted]);

  if (!mounted)
    return (
      <div
        className="aspect-video w-full rounded-lg bg-black bg-contain bg-center bg-no-repeat"
        style={poster ? { backgroundImage: `url(${poster})` } : undefined}
      />
    );
  return (
    <div className="grid gap-2">
      <MediaController
        className="aspect-video w-full overflow-hidden rounded-lg bg-black"
        aria-label={title}
      >
        {/* biome-ignore lint/a11y/useMediaCaption: caption tracks are added when uploaded */}
        <video
          ref={video}
          slot="media"
          poster={poster}
          preload="metadata"
          playsInline
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            tracker.setDuration(v.duration);
            if (initialPosition > 1 && initialPosition < v.duration - 5)
              v.currentTime = initialPosition;
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            const back = tracker.onTime(v.currentTime);
            if (back !== null) v.currentTime = back;
          }}
          onSeeking={(e) => {
            const v = e.currentTarget;
            if (noSeekAhead && v.currentTime > tracker.furthest.current + 1) {
              v.currentTime = tracker.furthest.current;
            }
          }}
          onPause={() => void tracker.flush()}
          onEnded={() => void tracker.flush()}
        >
          {captions.map((c) => (
            <track key={c.lang} kind="subtitles" src={c.url} srcLang={c.lang} label={c.label} />
          ))}
          {sprite ? <track kind="metadata" label="thumbnails" src={sprite} default /> : null}
        </video>
        <MediaLoadingIndicator slot="centered-chrome" noAutohide />
        <MediaControlBar>
          <MediaPlayButton />
          <MediaSeekBackwardButton seekOffset={10} />
          {noSeekAhead ? null : <MediaSeekForwardButton seekOffset={10} />}
          <MediaTimeRange>
            <MediaPreviewThumbnail slot="preview" />
            <MediaPreviewTimeDisplay slot="preview" />
          </MediaTimeRange>
          <MediaTimeDisplay showDuration />
          <MediaMuteButton />
          <MediaVolumeRange />
          <MediaPlaybackRateButton />
          {captions.length ? <MediaCaptionsButton /> : null}
          <MediaFullscreenButton />
        </MediaControlBar>
      </MediaController>
      {percent !== null ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t('watched', { percent: Math.round(percent) })}
        </p>
      ) : null}
    </div>
  );
}

// ── embedded players ─────────────────────────────────────────────────────────

type YTPlayer = {
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  seekTo(s: number, allow: boolean): void;
};
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, o: object) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
    VK?: { VideoPlayer(el: HTMLIFrameElement): VkPlayer };
  }
}
type VkPlayer = {
  on(event: string, fn: (s: { time?: number; duration?: number }) => void): void;
  getDuration(): number;
  seek(t: number): void;
};

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.append(s);
  });
}

/**
 * YouTube / RuTube / VK Video behind one adapter: each reports playback time to the
 * watch tracker and can seek back when "no seeking ahead" is on.
 */
export function EmbedPlayer({
  activityId,
  provider,
  embedUrl,
  noSeekAhead,
  initial,
  title,
}: {
  activityId: string;
  provider: EmbedProvider;
  embedUrl: string;
  noSeekAhead: boolean;
  initial: Interval[];
  title: string;
}) {
  const t = useTranslations('mod.video');
  const frame = useRef<HTMLIFrameElement>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const tracker = useWatchTracker(activityId, { initial, noSeekAhead, onPercent: setPercent });

  // biome-ignore lint/correctness/useExhaustiveDependencies: set up once per embed; tracker reads refs
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let stop = () => {};
    if (provider === 'youtube') {
      let timer: ReturnType<typeof setInterval> | undefined;
      const start = () => {
        const player = new window.YT!.Player(el, {
          events: {
            onReady: () => {
              tracker.setDuration(player.getDuration());
              timer = setInterval(() => {
                if (player.getPlayerState() !== 1) return; // playing
                tracker.setDuration(player.getDuration());
                const back = tracker.onTime(player.getCurrentTime());
                if (back !== null) player.seekTo(back, true);
              }, 1000);
            },
            onStateChange: (e: { data: number }) => {
              if (e.data === 2 || e.data === 0) void tracker.flush();
            },
          },
        });
      };
      if (window.YT?.Player) start();
      else {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
          prev?.();
          start();
        };
        void loadScript('https://www.youtube.com/iframe_api');
      }
      stop = () => clearInterval(timer);
    } else if (provider === 'rutube') {
      const onMessage = (e: MessageEvent) => {
        if (e.source !== el.contentWindow) return;
        let msg: { type?: string; data?: { time?: number; duration?: number; state?: string } };
        try {
          msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        } catch {
          return;
        }
        if (msg.type === 'player:durationChange' && msg.data?.duration)
          tracker.setDuration(msg.data.duration);
        if (msg.type === 'player:currentTime' && typeof msg.data?.time === 'number') {
          const back = tracker.onTime(msg.data.time);
          if (back !== null)
            el.contentWindow?.postMessage(
              JSON.stringify({ type: 'player:setCurrentTime', data: { time: back } }),
              '*',
            );
        }
        if (msg.type === 'player:changeState' && msg.data?.state !== 'playing')
          void tracker.flush();
      };
      window.addEventListener('message', onMessage);
      stop = () => window.removeEventListener('message', onMessage);
    } else if (provider === 'vk') {
      void loadScript('https://vk.com/js/api/videoplayer.js').then(() => {
        const player = window.VK?.VideoPlayer(el);
        if (!player) return;
        player.on('inited', () => tracker.setDuration(player.getDuration()));
        player.on('timeupdate', (s) => {
          if (typeof s.time !== 'number') return;
          const back = tracker.onTime(s.time);
          if (back !== null) player.seek(back);
        });
        player.on('paused', () => void tracker.flush());
        player.on('ended', () => void tracker.flush());
      });
    }
    return () => stop();
  }, [provider, embedUrl]);

  return (
    <div className="grid gap-2">
      <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
        <iframe
          ref={frame}
          src={embedUrl}
          title={title}
          className="size-full"
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture; screen-wake-lock"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
      {percent !== null ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t('watched', { percent: Math.round(percent) })}
        </p>
      ) : null}
    </div>
  );
}

// ── management ───────────────────────────────────────────────────────────────

function useAction(activityId: string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (action: string, input: Record<string, unknown>, files?: File[], ok?: string) =>
    start(async () => {
      const r = await callModuleAction(
        activityId,
        action,
        input,
        files ? { list: files } : undefined,
      );
      if (!r.ok) return void toast.error(r.message ?? 'Error');
      if (ok) toast.success(ok);
      router.refresh();
    });
  return { pending, run };
}

export function VideoUploader({ activityId, hasVideo }: { activityId: string; hasVideo: boolean }) {
  const t = useTranslations('mod.video');
  const router = useRouter();
  const [progress, setProgress] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const upload = async (file: File) => {
    abort.current = new AbortController();
    setProgress(0);
    try {
      const uploadId = await uploadResumable(file, {
        onProgress: setProgress,
        signal: abort.current.signal,
      });
      const r = await callModuleAction(activityId, 'attachUpload', { uploadId });
      if (!r.ok) throw new Error(r.message);
      toast.success(t('uploaded'));
      router.refresh();
    } catch (e) {
      if (!abort.current?.signal.aborted) toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };
  return (
    <div className="grid gap-2">
      <Field
        label={hasVideo ? t('replaceVideo') : t('uploadVideo')}
        htmlFor="video-file"
        hint={t('uploadHint')}
      >
        <Input
          id="video-file"
          type="file"
          accept="video/*"
          disabled={progress !== null}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
      </Field>
      {progress !== null ? (
        <div className="flex items-center gap-3">
          <Progress
            value={Math.round(progress * 100)}
            label={t('uploading', { percent: Math.round(progress * 100) })}
            className="flex-1"
          />
          <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}>
            {t('cancel')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Refreshes the page when the worker reports transcoding progress for this video. */
export function StatusWatcher({ activityId, active }: { activityId: string; active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const onEvent = (e: Event) => {
      const d = (e as CustomEvent<{ type: string; data: { activityId?: string } }>).detail;
      if (d.type === 'video.status' && d.data.activityId === activityId) router.refresh();
    };
    window.addEventListener('hubium:realtime', onEvent);
    // fallback when realtime is unavailable
    const poll = setInterval(() => router.refresh(), 10_000);
    return () => {
      window.removeEventListener('hubium:realtime', onEvent);
      clearInterval(poll);
    };
  }, [active, activityId, router]);
  return null;
}

export function RetranscodeButton({ activityId }: { activityId: string }) {
  const t = useTranslations('mod.video');
  const { pending, run } = useAction(activityId);
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run('retranscode', {})}>
      {t('retranscode')}
    </Button>
  );
}

/** Common caption languages; the interface language is always offered. */
const CAPTION_LANGS = ['ru', 'en', 'de', 'fr', 'it', 'es', 'pt', 'uk', 'zh', 'ja', 'ar'];

/** A language's name in that language, e.g. "Deutsch" for de. */
function ownName(code: string): string {
  try {
    const n = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
    return n.charAt(0).toLocaleUpperCase(code) + n.slice(1);
  } catch {
    return code;
  }
}

export function CaptionsManager({
  activityId,
  captions,
}: {
  activityId: string;
  captions: { lang: string; label: string; url: string }[];
}) {
  const t = useTranslations('mod.video');
  const locale = useLocale().split('-')[0]!;
  const { pending, run } = useAction(activityId);
  const codes = CAPTION_LANGS.includes(locale) ? CAPTION_LANGS : [locale, ...CAPTION_LANGS];
  const [lang, setLang] = useState(locale);
  // the label follows the language until someone types their own
  const [label, setLabel] = useState<string | null>(null);
  return (
    <div className="grid gap-3">
      {captions.length ? (
        <ul className="grid gap-1 text-sm">
          {captions.map((c) => (
            <li key={c.lang} className="flex items-center gap-2">
              <a href={c.url} className="hover:underline">
                {c.label} ({c.lang})
              </a>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => run('removeCaption', { lang: c.lang })}
              >
                {t('remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="grid gap-3 sm:grid-cols-[8rem_1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const file = fd.get('file');
          if (!(file instanceof File) || !file.size) return;
          run(
            'addCaption',
            { lang: String(fd.get('lang')), label: String(fd.get('label')) },
            [file],
            t('captionAdded'),
          );
          e.currentTarget.reset();
          setLabel(null);
        }}
      >
        <Field label={t('captionLang')} htmlFor="cap-lang">
          <Select id="cap-lang" name="lang" value={lang} onChange={(e) => setLang(e.target.value)}>
            {codes.map((c) => (
              <option key={c} value={c} lang={c}>
                {ownName(c)} ({c})
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('captionLabel')} htmlFor="cap-label">
          <Input
            id="cap-label"
            name="label"
            required
            maxLength={60}
            value={label ?? ownName(lang)}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label={t('captionFile')} htmlFor="cap-file">
          <Input id="cap-file" name="file" type="file" accept=".vtt,.srt,text/vtt" required />
        </Field>
        <Button type="submit" disabled={pending}>
          {t('addCaption')}
        </Button>
      </form>
    </div>
  );
}
