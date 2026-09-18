import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const MAX_JSON = 8 * 1024 * 1024;
export const MAX_MODEL = 128 * 1024 * 1024;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function check(ok, message) { if (!ok) throw new Error(message); }
export function sha(value, label = 'SHA-256') {
  check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), `${label} must be 64 lowercase hexadecimal characters.`);
  return value;
}
export function object(value, label) {
  check(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`);
  return value;
}
export function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) check(allowed.includes(key), `Unknown ${label} field: ${key}`);
}
export function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export async function context(workspace) {
  if (!workspace) return { root: null };
  check(path.isAbsolute(workspace), 'Workspace must be an absolute path.');
  const root = await fs.realpath(workspace);
  check((await fs.stat(root)).isDirectory(), 'Workspace must be a directory.');
  return { root };
}
export async function inputPath(value, base = process.cwd(), ctx = {}) {
  check(typeof value === 'string' && value.length > 0 && !value.includes('\0'), 'A local path is required.');
  const full = await fs.realpath(path.resolve(base, value));
  check(!ctx.root || inside(ctx.root, full), 'Input escapes the allowed workspace.');
  check((await fs.stat(full)).isFile(), 'Input must be a regular file.');
  return full;
}
export async function outputPath(value, ctx = {}) {
  check(typeof value === 'string' && value.length > 0, 'An output path is required.');
  const full = path.resolve(value);
  const parent = await fs.realpath(path.dirname(full));
  check(!ctx.root || inside(ctx.root, parent), 'Output escapes the allowed workspace.');
  const result = path.join(parent, path.basename(full));
  try { await fs.lstat(result); throw new Error('Output already exists; choose a new filename.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return result;
}
export async function writeNew(filename, bytes, ctx = {}) {
  const full = await outputPath(filename, ctx);
  await fs.writeFile(full, bytes, { flag: 'wx', mode: 0o600 });
  return full;
}
export async function readJson(filename, base = process.cwd(), ctx = {}) {
  const full = await inputPath(filename, base, ctx);
  check((await fs.stat(full)).size <= MAX_JSON, 'JSON exceeds the 8 MiB limit.');
  const bytes = await fs.readFile(full);
  check(bytes.length <= MAX_JSON, 'JSON exceeds the 8 MiB limit.');
  return { path: full, bytes, value: JSON.parse(bytes.toString('utf8')), sha256: digest(bytes) };
}
export async function hashFile(filename, limit = MAX_MODEL) {
  check((await fs.stat(filename)).size <= limit, 'File exceeds the supported size limit.');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filename)) {
    size += chunk.length;
    check(size <= limit, 'File exceeds the supported size limit.');
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), byte_length: size };
}
export async function pinFile(descriptor, base, ctx, limit = MAX_MODEL) {
  keys(descriptor, ['path', 'sha256'], 'file binding');
  sha(descriptor.sha256);
  const full = await inputPath(descriptor.path, base, ctx);
  const actual = await hashFile(full, limit);
  check(actual.sha256 === descriptor.sha256, 'File SHA-256 does not match its pinned binding.');
  return { path: full, ...actual };
}
