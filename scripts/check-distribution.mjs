import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { digest } from '../lib/io.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'review-release-'));
try {
  new AdmZip(path.join(root,'dist/deepbom-review-0.1.0.zip')).extractAllTo(temp);
  const provenance=JSON.parse(await fs.readFile(path.join(temp,'PROVENANCE.json')));
  for(const file of provenance.files) assert.equal(digest(await fs.readFile(path.join(temp,file.path))),file.sha256);
  const cli=path.join(temp,'bin/deepbom-review.mjs');
  const run=args=>JSON.parse(execFileSync(process.execPath,[cli,...args],{encoding:'utf8'}));
  assert.equal(run(['capabilities']).engine_version,'1.103.0');
  const request=path.join(temp,'request.json');
  run(['prepare','--baseline',path.join(root,'test/fixtures/baseline.onnx'),'--candidate',path.join(root,'test/fixtures/candidate.onnx'),'--policy',path.join(temp,'examples/policy.json'),'--change','Distribution test','--out',request]);
  let result;
  try {run(['run',request,'--out',path.join(temp,'review.zip')]);assert.fail('Missing evaluation should hold.');}
  catch(error){assert.equal(error.status,3);result=JSON.parse(error.stdout);}
  assert.equal(run(['verify',path.join(temp,'review.zip'),'--expected-sha256',result.sha256]).integrity,'verified');
  console.log('Extracted distribution: dependency provenance, pinned engine, real review and verification passed.');
} finally {await fs.rm(temp,{recursive:true,force:true});}
