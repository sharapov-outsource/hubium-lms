import { up } from './stack';

export default async function globalSetup() {
  if (process.env.NODE_STACK !== 'running') await up();
}
