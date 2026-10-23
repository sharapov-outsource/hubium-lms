import { down } from './lab';

export default async function globalTeardown() {
  if (process.env.LAB === 'running' || process.env.LAB_KEEP) return;
  await down();
}
