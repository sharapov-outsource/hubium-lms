import './service.ts';
import { shutdownTelemetry, startTelemetry } from '@hubium/telemetry';
import { cli } from './main.ts';

startTelemetry({ service: process.env.HUBIUM_SERVICE ?? 'cli', fetch: true });
process.exitCode = await cli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
await shutdownTelemetry();
