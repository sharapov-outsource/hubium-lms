import { describe, expect, it } from 'vitest';
import {
  coveredSeconds,
  hlsArgs,
  ladderFor,
  mergeIntervals,
  parseEmbed,
  progressSeconds,
  spritePlan,
  spriteVtt,
  srtToVtt,
  watchPercent,
} from './media.ts';

describe('watched intervals', () => {
  it('merges overlaps and small gaps, clamps to duration', () => {
    expect(
      mergeIntervals(
        [
          [10, 20],
          [0, 5],
          [19, 30],
          [30.3, 40],
          [95, 120],
          [50, 50],
        ],
        100,
      ),
    ).toEqual([
      [0, 5],
      [10, 40],
      [95, 100],
    ]);
  });
  it('computes coverage and percent', () => {
    const m = mergeIntervals([
      [0, 45],
      [40, 90],
    ]);
    expect(coveredSeconds(m)).toBe(90);
    expect(watchPercent(m, 100)).toBe(90);
    expect(watchPercent(m, 0)).toBe(0);
    expect(watchPercent([[0, 500]], 100)).toBe(100);
  });
});

describe('HLS ladder and ffmpeg', () => {
  it('caps the ladder at the source', () => {
    expect(ladderFor(1080).map((r) => r.height)).toEqual([360, 720, 1080]);
    expect(ladderFor(2160).map((r) => r.height)).toEqual([360, 720, 1080]);
    expect(ladderFor(720).map((r) => r.height)).toEqual([360, 720]);
    expect(ladderFor(241).map((r) => r.height)).toEqual([240]);
  });
  it('builds a var_stream_map per rendition', () => {
    const a = hlsArgs({ input: 'in.mp4', outDir: '/o', ladder: ladderFor(720), hasAudio: true });
    expect(a[a.indexOf('-var_stream_map') + 1]).toBe('v:0,a:0 v:1,a:1');
    expect(a).toContain('fmp4');
    expect(a.at(-1)).toBe('/o/v%v/index.m3u8');
    const silent = hlsArgs({
      input: 'in.mp4',
      outDir: '/o',
      ladder: ladderFor(360),
      hasAudio: false,
    });
    expect(silent[silent.indexOf('-var_stream_map') + 1]).toBe('v:0');
    expect(silent).not.toContain('0:a:0');
  });
  it('parses progress output', () => {
    expect(progressSeconds('frame=10\nout_time_us=1500000\nprogress=continue\n')).toBe(1.5);
    expect(progressSeconds('nothing')).toBeNull();
  });
});

describe('captions and thumbnails', () => {
  it('converts SRT to VTT', () => {
    const vtt = srtToVtt('﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nПривет\r\n');
    expect(vtt).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nПривет\n');
    expect(srtToVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nx')).toMatch(/^WEBVTT/);
  });
  it('plans sprites and maps tiles', () => {
    const p = spritePlan(65);
    expect(p).toMatchObject({ interval: 2, count: 33, cols: 10, rows: 4 });
    const vtt = spriteVtt(p, 65, 'sprite.jpg');
    expect(vtt).toContain('00:00:00.000 --> 00:00:02.000\nsprite.jpg#xywh=0,0,160,90');
    expect(vtt).toContain('sprite.jpg#xywh=160,0,160,90');
    expect(vtt).toContain('00:01:04.000 --> 00:01:05.000');
    expect(spritePlan(1000).count).toBeLessThanOrEqual(100);
  });
});

describe('embeds', () => {
  it('recognises YouTube, RuTube and VK links', () => {
    expect(parseEmbed('https://youtu.be/dQw4w9WgXcQ')?.embedUrl).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1&rel=0',
    );
    expect(parseEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')?.id).toBe('dQw4w9WgXcQ');
    expect(parseEmbed('https://youtube.com/shorts/abcdefghijk')?.provider).toBe('youtube');
    expect(parseEmbed('https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/')).toMatchObject({
      provider: 'rutube',
      embedUrl: 'https://rutube.ru/play/embed/c6cc4d620b1d4338901770a44b3e82f4',
    });
    expect(parseEmbed('https://vk.com/video-22822305_456239018')).toMatchObject({
      provider: 'vk',
      id: '-22822305_456239018',
    });
    expect(parseEmbed('https://vkvideo.ru/video_ext.php?oid=-1&id=2&hash=abc')?.embedUrl).toContain(
      'hash=abc',
    );
    expect(parseEmbed('https://example.com/video.mp4')).toBeNull();
    expect(parseEmbed('not a url')).toBeNull();
  });
});
