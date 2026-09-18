import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { prepare, runReview, verifyBundle } from '../lib/review.mjs';
import { importEvaluation } from '../lib/evaluation.mjs';
import { decide, validatePolicy } from '../lib/decision.mjs';
import { hashFile, jsonBytes, digest, context } from '../lib/io.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = name => path.join(root,'test','fixtures',name);
async function sandbox(t, format='onnx') {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'deepbom review '));
  t.after(() => fs.rm(work,{ recursive:true, force:true }));
  const put = async (name, value) => { const p=path.join(work,name); await fs.writeFile(p,jsonBytes(value)); return p; };
  const baseline = path.join(work,`baseline.${format}`), candidate = path.join(work,`candidate.${format}`);
  await fs.copyFile(fixture(format === 'onnx' ? 'baseline.onnx' : 'relu.tflite'),baseline);
  await fs.copyFile(fixture(format === 'onnx' ? 'candidate.onnx' : 'relu.tflite'),candidate);
  const policy = await put('policy.json',JSON.parse(await fs.readFile(path.join(root,'examples','policy.json'))));
  const files = {};
  for (const name of ['dataset','evaluator','environment']) files[name]=await put(`${name}.json`,{ synthetic_test_fixture:true, name });
  const binding = async (role, metrics = {accuracy:0.95,latency:10}, source='generic') => {
    const artifact=role==='baseline'?baseline:candidate;
    const b={ schema:'deepbom.review.bindings.v1', producer_statement:'these_files_were_used_for_this_evaluation', metrics:{accuracy:{key:'accuracy',unit:'fraction'},latency:{key:'latency',unit:'ms'}} };
    for(const [name,p] of Object.entries({artifact,...files})) b[name]={path:p,sha256:(await hashFile(p)).sha256};
    let input;
    if(source==='generic') input={schema:'deepbom.review.external_result.v1',run_id:`synthetic-${role}`,status:'completed',artifact_sha256:b.artifact.sha256,contexts:Object.fromEntries(Object.entries(files).map(([name])=>[name,b[name].sha256])),metrics};
    if(source==='mlflow') input={run:{info:{status:'FINISHED',run_id:`synthetic-${role}`},data:{metrics:Object.entries(metrics).map(([key,value])=>({key,value,timestamp:1,step:0})),tags:Object.entries({artifact,...files}).map(([name])=>({key:`deepbom.${name}.sha256`,value:b[name].sha256}))}}};
    if(source==='olive') {b.olive_rank=1;input=[{rank:1,model_config:{type:'ONNXModel',config:{model_path:artifact}},metrics:Object.fromEntries(Object.entries(metrics).map(([key,value])=>[key,{value,priority:1,higher_is_better:key==='accuracy'}]))}];}
    const bindings=await put(`${role}-${source}-bindings.json`,b), inputFile=await put(`${role}-${source}-source.json`,input), out=path.join(work,`${role}-${source}-receipt.json`);
    await importEvaluation({source,input:inputFile,bindings,out});
    return {out,bindings,input:inputFile,b};
  };
  const build = async (name,extra={}) => {
    const request=path.join(work,`${name}.request.json`), out=path.join(work,`${name}.zip`);
    const {include_models,...rest}=extra;
    await prepare({baseline,candidate,policy,change:'Synthetic test candidate; not a performance claim.',out:request,...rest});
    return { ...(await runReview({request,out,include_models})),request,out };
  };
  return {work,put,baseline,candidate,policy,files,binding,build};
}

test('real ONNX audit/diff, fixed metric accept, archive verification and optional model bytes',async t=>{
  const s=await sandbox(t);
  const a=await s.binding('baseline',{accuracy:0.95,latency:12},'mlflow');
  const b=await s.binding('candidate',{accuracy:0.95,latency:10},'olive');
  const r=await s.build('accepted',{baseline_evaluation:a.out,candidate_evaluation:b.out,include_models:true});
  assert.equal(r.decision,'accept',JSON.stringify(r.checks));
  assert.equal((await verifyBundle({bundle:r.out,expected_sha256:r.sha256})).decision,'accept');
  const z=new AdmZip(r.out);
  assert.equal(digest(z.readFile('models/candidate.onnx')),r.artifacts.candidate.sha256);
  assert.ok(JSON.parse(z.readAsText('candidate.envelope.json')).findings.some(f=>f.finding_kind==='evidence_gap'));
  assert.notEqual(r.artifacts.baseline.sha256,r.artifacts.candidate.sha256);
  await assert.rejects(verifyBundle({bundle:r.out,expected_sha256:'0'.repeat(64)}),/independently expected/);
  z.updateFile('policy.json',Buffer.from('{}'));
  const bad=path.join(s.work,'tampered.zip');await fs.writeFile(bad,z.toBuffer());
  await assert.rejects(verifyBundle({bundle:bad}),/integrity mismatch/);
});

test('missing measurements hold, quality regression rejects, unit/context mismatch holds',async t=>{
  const s=await sandbox(t);
  const missing=await s.build('missing');
  assert.equal(missing.decision,'hold');
  assert.ok(!new AdmZip(missing.out).getEntries().some(e=>e.entryName.startsWith('models/')));
  const a=await s.binding('baseline',{accuracy:0.95,latency:12});
  const b=await s.binding('candidate',{accuracy:0.8,latency:10});
  assert.equal((await s.build('regression',{baseline_evaluation:a.out,candidate_evaluation:b.out})).decision,'reject');
  const z=new AdmZip(missing.out);
  const baseline=JSON.parse(z.readAsText('baseline.envelope.json')),candidate=JSON.parse(z.readAsText('candidate.envelope.json'));
  const policy=JSON.parse(await fs.readFile(s.policy));
  const before=JSON.parse(await fs.readFile(a.out)),after=JSON.parse(await fs.readFile(b.out));
  after.metrics.accuracy.value=.95;after.metrics.latency.unit='seconds';
  const evaluate=()=>decide({policy,baseline,candidate,baselineEvaluation:before,candidateEvaluation:after});
  assert.equal(evaluate().status,'hold');
  after.metrics.latency.unit='ms';after.metrics.accuracy.value=.94;assert.equal(evaluate().status,'accept','inclusive decimal regression boundary');
  after.metrics.accuracy.value=.939999;assert.equal(evaluate().status,'reject','a real threshold violation is not rounded away');
  after.metrics.accuracy.value=.95;
  after.metrics.latency.unit='ms';after.contexts.dataset.sha256='0'.repeat(64);assert.equal(evaluate().status,'hold');
  after.contexts.dataset.sha256=before.contexts.dataset.sha256;after.artifact_sha256='0'.repeat(64);assert.equal(evaluate().status,'hold');
  after.artifact_sha256=candidate.identity.sha256;delete after.metrics.accuracy;assert.equal(evaluate().status,'hold');
  const bad=structuredClone(policy);bad.fail_open=true;assert.throws(()=>validatePolicy(bad),/Unknown/);
  policy.required_capabilities.push('runtime_floor');assert.equal(evaluate().status,'hold');
});

test('interface changes reject; actual TFLite can produce a verified review',async t=>{
  const s=await sandbox(t);
  await fs.copyFile(fixture('changed-interface.onnx'),s.candidate);
  const changed=await s.build('interface-change');
  assert.equal(changed.decision,'reject');
  assert.equal(changed.checks.find(c=>c.id==='interface_preservation').state,'fail');
  const tf=await sandbox(t,'tflite');
  const a=await tf.binding('baseline'),b=await tf.binding('candidate');
  const r=await tf.build('tflite',{baseline_evaluation:a.out,candidate_evaluation:b.out});
  assert.equal(r.decision,'accept',JSON.stringify(r.checks));
  assert.equal((await verifyBundle({bundle:r.out})).integrity,'verified');
});

test('hash pinning, no-clobber, importer binding checks and transitive workspace boundaries',async t=>{
  const s=await sandbox(t);
  const request=path.join(s.work,'request.json');
  await prepare({baseline:s.baseline,candidate:s.candidate,policy:s.policy,change:'test',out:request});
  await assert.rejects(prepare({baseline:s.baseline,candidate:s.candidate,policy:s.policy,change:'test',out:request}),/already exists/);
  const pol=await fs.readFile(s.policy);await fs.appendFile(s.policy,' ');
  await assert.rejects(runReview({request,out:path.join(s.work,'bad.zip')}),/SHA-256/);
  await fs.writeFile(s.policy,pol);
  const original=await fs.readFile(s.candidate);await fs.appendFile(s.candidate,'x');
  await assert.rejects(runReview({request,out:path.join(s.work,'bad.zip')}),/SHA-256/);
  await fs.writeFile(s.candidate,original);
  const m=await s.binding('candidate',undefined,'mlflow');
  const raw=JSON.parse(await fs.readFile(m.input));raw.run.data.tags=[];await fs.writeFile(m.input,jsonBytes(raw));
  await assert.rejects(importEvaluation({source:'mlflow',input:m.input,bindings:m.bindings,out:path.join(s.work,'badreceipt.json')}),/MLflow binding tag/);
  const safe=path.join(s.work,'safe');await fs.mkdir(safe);
  const ctx=await context(safe);
  await fs.copyFile(request,path.join(safe,'request.json'));
  const indirect=JSON.parse(await fs.readFile(request));
  for(const name of ['policy','baseline','candidate']) indirect[name].path=path.join(s.work,indirect[name].path);
  await fs.writeFile(path.join(safe,'request.json'),jsonBytes(indirect));
  await assert.rejects(runReview({request:path.join(safe,'request.json'),out:path.join(safe,'out.zip')},ctx),/escapes/);
  await fs.symlink(s.work,path.join(safe,'escape'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(verifyBundle({bundle:path.join(safe,'escape','request.json')},ctx),/escapes/);
  await assert.rejects(prepare({baseline:s.baseline,candidate:s.candidate,policy:s.policy,change:'test',out:path.join(safe,'escape','new.json')},ctx),/escapes/);
});

test('CLI hold exit code and host configs with absolute paths',async t=>{
  const s=await sandbox(t);const r=await s.build('first');
  const entry=path.join(root,'bin','deepbom-review.mjs');
  const cli=spawnSync(process.execPath,[entry,'run',r.request,'--out',path.join(s.work,'cli.zip')],{encoding:'utf8'});
  assert.equal(cli.status,3,cli.stderr);assert.equal(JSON.parse(cli.stdout).decision,'hold');
  for(const host of ['copilot','vscode','gemini']) {
    const config=spawnSync(process.execPath,[entry,'config','--host',host,'--workspace',s.work],{encoding:'utf8'});
    assert.equal(config.status,0,config.stderr);
    const servers=Object.values(JSON.parse(config.stdout))[0];
    assert.equal(servers['deepbom-review'].args.at(-1),await fs.realpath(s.work));
    assert.equal(servers.deepbom.command,process.execPath);
  }
});

test('unreadable model structure is packaged as hold, never a defect-free pass',async t=>{
  const s=await sandbox(t);await fs.writeFile(s.candidate,Buffer.from('invalid onnx'));
  const r=await s.build('failed-analysis');
  assert.equal(r.decision,'hold');
  assert.equal(r.checks.find(c=>c.id==='candidate_defects').state,'unknown');
  assert.equal((await verifyBundle({bundle:r.out})).decision,'hold');
});
