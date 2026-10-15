import { describe, expect, it } from 'vitest';
import { parseVideoUrl, toEmbedUrl } from './embed.ts';

describe('video links', () => {
  it('reads the forms each service gives its links', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ])
      expect(parseVideoUrl(url)).toMatchObject({ provider: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(parseVideoUrl('https://rutube.ru/play/embed/0123456789abcdef0123456789abcdef')?.id).toBe(
      '0123456789abcdef0123456789abcdef',
    );
    expect(parseVideoUrl('https://vk.ru/video-1_2')).toMatchObject({ provider: 'vk', id: '-1_2' });
    expect(parseVideoUrl('https://vkvideo.ru/video_ext.php?oid=-1&id=2&hash=ab')).toMatchObject({
      id: '-1_2',
      hash: 'ab',
    });
    expect(parseVideoUrl('https://player.vimeo.com/video/76979871')?.id).toBe('76979871');
  });

  it('takes the hosts themselves, not names that merely end like them', () => {
    expect(parseVideoUrl('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseVideoUrl('https://evil.vk.com.example.org/video-1_2')).toBeNull();
    expect(parseVideoUrl('javascript:alert(1)//youtube.com')).toBeNull();
    expect(parseVideoUrl('https://www.youtube.com/watch?v=<script>')).toBeNull();
  });

  it('embeds in the editor what the Video activity plays', () => {
    expect(toEmbedUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
    expect(toEmbedUrl('https://vk.com/video-12345_67890')).toBe(
      'https://vkvideo.ru/video_ext.php?oid=-12345&id=67890&hd=2',
    );
  });
});
