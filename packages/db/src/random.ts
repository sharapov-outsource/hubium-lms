import { randomBytes } from 'node:crypto';

// Random numbers an operation draws (the order of a quiz's questions, a random allocation):
// from a seed, so that the same seed gives the same numbers when the cloud replays an
// operation a local node ran. Secrets and tokens use node:crypto instead.

export interface Random {
  /** The seed it started from. */
  readonly seed: string;
  /** A number in [0, 1). */
  next(): number;
  /** An integer in [min, max). */
  int(min: number, max: number): number;
  /** A UUID with the version 4 layout. */
  uuid(): string;
}

/** A new seed: 128 random bits. */
export function newSeed(): string {
  return randomBytes(16).toString('hex');
}

/** The generator of a seed (sfc32, enough for shuffles and draws, not for secrets). */
export function seededRandom(seed: string): Random {
  if (!/^[0-9a-f]{32}$/.test(seed)) throw new Error('A seed is 32 hexadecimal digits');
  let [a, b, c, d] = [0, 8, 16, 24].map((i) => Number.parseInt(seed.slice(i, i + 8), 16)) as [
    number,
    number,
    number,
    number,
  ];
  const u32 = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  // the first numbers of a fresh state mix poorly
  for (let i = 0; i < 12; i++) u32();
  const next = () => u32() / 2 ** 32;
  return {
    seed,
    next,
    int: (min, max) => min + Math.floor(next() * (max - min)),
    uuid() {
      const h = Array.from({ length: 4 }, () => u32().toString(16).padStart(8, '0')).join('');
      const variant = ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
    },
  };
}
