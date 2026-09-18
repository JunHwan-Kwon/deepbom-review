import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { digest, jsonBytes, check } from '../lib/io.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const zip = new AdmZip();
async function add(name) {
  const full = path.join(root, name);
  const stat = await fs.lstat(full);
  check(!stat.isSymbolicLink(), 'Release must not contain symlinks.');
  if (stat.isDirectory()) for (const child of (await fs.readdir(full)).sort()) { if (child !== '__pycache__') await add(`${name}/${child}`); }
  else { zip.addFile(name, await fs.readFile(full)); zip.getEntry(name).header.time = new Date(1980,0,1); }
}
for (const name of ['package.json','package-lock.json','bin','lib','examples','adapters','README.md','LICENSE','VALIDATION.md','node_modules/deepbom','node_modules/adm-zip']) await add(name);
const provenance = { schema: 'deepbom.review.distribution.v1', version: pkg.version, dependencies: pkg.dependencies,
  files: zip.getEntries().map(e => ({ path: e.entryName, sha256: digest(e.getData()) })) };
zip.addFile('PROVENANCE.json', jsonBytes(provenance));
zip.getEntry('PROVENANCE.json').header.time = new Date(1980,0,1);
await fs.mkdir(path.join(root,'dist'), { recursive: true });
const name = `deepbom-review-${pkg.version}.zip`;
const bytes = zip.toBuffer();
await fs.writeFile(path.join(root,'dist',name), bytes);
await fs.writeFile(path.join(root,'dist','SHA256SUMS'), `${digest(bytes)}  ${name}\n`);
console.log(`Packaged ${name}: ${bytes.length} bytes, ${digest(bytes)}`);
