import { down } from './stack';

export default async function globalTeardown() {
  if (process.env.NODE_STACK !== 'running' && !process.env.NODE_STACK_KEEP) await down();
}
