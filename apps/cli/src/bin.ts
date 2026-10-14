import './service.ts';
import { cli } from './main.ts';

process.exitCode = await cli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
