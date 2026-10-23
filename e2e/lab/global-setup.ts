import { build, labReady, labState, up } from './lab';

// The lab before its scenarios: the images built (the app's only when missing) and the
// cloud installed, unless LAB=running says it is up. The scenarios read and change the
// cloud's database (tests/db.ts).
export default async function globalSetup() {
  if (process.env.LAB !== 'running' || !labReady()) {
    build();
    await up();
  }
  process.env.DATABASE_URL = labState().cloudDb;
}
