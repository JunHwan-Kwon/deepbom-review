import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
export function connect(entry,workspace,command='mcp') {
  const child=spawn(process.execPath,[entry,command,'--workspace',workspace],{stdio:['pipe','pipe','pipe'],env:{...process.env,DEEPBOM_MCP_ALLOWED_ROOTS:path.dirname(workspace)},windowsHide:true});
  let seq=0,buffer='',stderr='';const waiters=new Map();
  const closed=new Promise(resolve=>child.on('close',resolve));
  child.stderr.on('data',chunk=>stderr+=chunk);
  child.stdout.on('data',chunk=>{
    buffer+=chunk;let i;
    while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line)continue;const frame=JSON.parse(line);const waiter=waiters.get(frame.id);if(!waiter)continue;clearTimeout(waiter.timer);waiters.delete(frame.id);frame.error?waiter.reject(new Error(frame.error.message)):waiter.resolve(frame.result);}
  });
  child.on('close',()=>{for(const w of waiters.values()){clearTimeout(w.timer);w.reject(new Error(stderr||'MCP closed'));}});
  const request=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{waiters.delete(id);reject(new Error('MCP timeout'));},30000);waiters.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  return {request,call:(name,args)=>request('tools/call',{name,arguments:args}),close:async()=>{child.stdin.end();const timer=setTimeout(()=>child.kill(),5000);await closed;clearTimeout(timer);}};
}
test('stdio MCP initializes, prepares/builds/verifies, bounds paths, and exposes correct write annotations',async t=>{
  const work=await fs.mkdtemp(path.join(os.tmpdir(),'review-mcp-'));const clients=[];
  t.after(async()=>{await Promise.allSettled(clients.map(client=>client.close()));await fs.rm(work,{recursive:true,force:true});});
  const workspace=path.join(work,process.platform==='win32'?'model folder':'model:folder');await fs.mkdir(workspace);
  await fs.copyFile(path.join(root,'test/fixtures/baseline.onnx'),path.join(workspace,'a.onnx'));
  await fs.copyFile(path.join(root,'test/fixtures/candidate.onnx'),path.join(workspace,'b.onnx'));
  await fs.copyFile(path.join(root,'examples/policy.json'),path.join(workspace,'policy.json'));
  const client=connect(path.join(root,'bin/deepbom-review.mjs'),workspace);clients.push(client);
  const init=await client.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}});
  assert.equal(init.serverInfo.version,'0.1.0');
  const tools=(await client.request('tools/list')).tools;
  assert.equal(tools.find(x=>x.name==='deepbom_review_build').annotations.readOnlyHint,false);
  assert.equal(tools.find(x=>x.name==='deepbom_review_verify').annotations.readOnlyHint,true);
  assert.equal((await client.call('deepbom_review_prepare',{baseline:'a.onnx',candidate:'b.onnx',policy:'policy.json',change:'Test',out:'request.json'})).isError,false);
  const build=await client.call('deepbom_review_build',{request:'request.json',out:'review.zip'});
  assert.equal(build.isError,false,JSON.stringify(build));assert.equal(build.structuredContent.decision,'hold');
  assert.equal((await client.call('deepbom_review_verify',{bundle:'review.zip',expected_sha256:build.structuredContent.sha256})).structuredContent.integrity,'verified');
  await fs.copyFile(path.join(workspace,'review.zip'),path.join(work,'outside.zip'));
  assert.equal((await client.call('deepbom_review_verify',{bundle:'../outside.zip'})).isError,true);
  assert.equal((await client.call('deepbom_review_build',{request:'request.json',out:'review.zip',include_models:'false'})).isError,true);
  const engine=connect(path.join(root,'bin/deepbom-review.mjs'),workspace,'engine-mcp');clients.push(engine);
  assert.equal((await engine.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}})).serverInfo.version,'1.103.0');
  assert.equal((await engine.call('deepbom_audit',{path:'a.onnx',output_format:'envelope'})).isError,undefined);
});
