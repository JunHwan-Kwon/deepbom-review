import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
const copilot=process.argv[2];
assert.ok(copilot,'Pass the absolute Copilot CLI executable path.');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'deepbom-copilot-'));
try {
  const home=path.join(temp,'config');await fs.mkdir(home);
  const config=execFileSync(process.execPath,[path.join(root,'bin/deepbom-review.mjs'),'config','--host','copilot','--workspace',temp]);
  await fs.writeFile(path.join(home,'mcp-config.json'),config);
  const result=execFileSync(copilot,['mcp','list','--json'],{cwd:temp,encoding:'utf8',timeout:30000,env:{...process.env,COPILOT_HOME:home,COPILOT_AUTO_UPDATE:'false',COPILOT_OFFLINE:'true'}});
  const value=JSON.parse(result);
  assert.ok(JSON.stringify(value).includes('deepbom-review'),result);
  assert.ok(JSON.stringify(value).includes('engine-mcp'),result);
  console.log('Copilot recognized both generated MCP configurations in an isolated profile.');
} finally {await fs.rm(temp,{recursive:true,force:true});}
