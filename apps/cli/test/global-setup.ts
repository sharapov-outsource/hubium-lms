import path from 'node:path';
import { config as loadEnv } from 'dotenv';

export default async function setup() {
  loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });
  const { prepareTemplateDatabase } = await import('@hubium/db/testing');
  await prepareTemplateDatabase();
}
