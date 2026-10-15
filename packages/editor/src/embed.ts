// Links to video services, recognised the same way wherever a video can be embedded: the
// editor (on the server and in the browser) and the Video activity. No dependencies, so the
// browser bundle can take it.

export type VideoProvider = 'youtube' | 'rutube' | 'vk' | 'vimeo';

export interface VideoLink {
  provider: VideoProvider;
  /** The video's id at its provider (VK: owner_video). */
  id: string;
  /** The player address to embed, without options. */
  embedUrl: string;
  /** VK's access hash of a private video, kept for the player. */
  hash?: string;
}

const YOUTUBE = new Set(['youtube.com', 'youtube-nocookie.com']);

/** The video a link points to, or null for anything else (other hosts included). */
export function parseVideoUrl(raw: string | null | undefined): VideoLink | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // exact hosts only: a name that merely ends like one (notyoutube.com) is not it
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  if (host === 'youtu.be' || YOUTUBE.has(host)) {
    const id =
      host === 'youtu.be'
        ? u.pathname.slice(1).split('/')[0]
        : (u.searchParams.get('v') ?? /^\/(?:embed|shorts|live)\/([\w-]+)/.exec(u.pathname)?.[1]);
    return id && /^[\w-]{6,20}$/.test(id)
      ? { provider: 'youtube', id, embedUrl: `https://www.youtube-nocookie.com/embed/${id}` }
      : null;
  }
  if (host === 'rutube.ru') {
    const id = /^\/(?:video|play\/embed)\/([\da-f]{20,40})/.exec(u.pathname)?.[1];
    return id ? { provider: 'rutube', id, embedUrl: `https://rutube.ru/play/embed/${id}` } : null;
  }
  if (host === 'vk.com' || host === 'vk.ru' || host === 'vkvideo.ru') {
    let oid = u.searchParams.get('oid');
    let vid = u.searchParams.get('id');
    const m = /video(-?\d+)_(\d+)/.exec(u.pathname) ?? /video(-?\d+)_(\d+)/.exec(u.search);
    if (m) [, oid, vid] = m as unknown as [string, string, string];
    if (!oid || !vid || !/^-?\d+$/.test(oid) || !/^\d+$/.test(vid)) return null;
    const hash = u.searchParams.get('hash') ?? undefined;
    return {
      provider: 'vk',
      id: `${oid}_${vid}`,
      embedUrl: `https://vkvideo.ru/video_ext.php?oid=${oid}&id=${vid}${hash ? `&hash=${encodeURIComponent(hash)}` : ''}`,
      ...(hash ? { hash } : {}),
    };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = /^\/(?:video\/)?(\d+)/.exec(u.pathname)?.[1];
    return id ? { provider: 'vimeo', id, embedUrl: `https://player.vimeo.com/video/${id}` } : null;
  }
  return null;
}

/** The player address the editor embeds for a link (VK in HD), or null if unsupported. */
export function toEmbedUrl(raw: string): string | null {
  const v = parseVideoUrl(raw);
  if (!v) return null;
  return v.provider === 'vk' ? `${v.embedUrl}&hd=2` : v.embedUrl;
}
