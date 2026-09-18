import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { check } from './io.mjs';

const require = createRequire(import.meta.url);
export const engineEntry = path.join(path.dirname(require.resolve('deepbom/package.json')), 'bin', 'deepbom.mjs');
export const engineVersion = '1.103.0';
check(require('deepbom/package.json').version === engineVersion, 'Installed DEEPBOM engine does not match the pinned version.');
export async function engine(args, cwd, signal) {
  const env = { ...process.env };
  delete env.DEEPBOM_MCP_ALLOWED_ROOTS;
  const { stdout } = await promisify(execFile)(process.execPath, [engineEntry, ...args], {
    cwd, env, windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024, signal,
  });
  return JSON.parse(stdout);
}
