#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { context, check, jsonBytes } from '../lib/io.mjs';
import { capabilities, prepare, runReview, verifyBundle } from '../lib/review.mjs';
import { importEvaluation } from '../lib/evaluation.mjs';
import { engineEntry } from '../lib/engine.mjs';

const help = `DEEPBOM Review 0.1.0 (preview; Node.js 20+)

deepbom-review capabilities
deepbom-review prepare --baseline FILE --candidate FILE --policy FILE --change TEXT --out request.json
  [--baseline-evaluation receipt.json] [--candidate-evaluation receipt.json]
deepbom-review import-evaluation --source olive|mlflow|generic --input FILE --bindings FILE --out receipt.json
deepbom-review run request.json --out review.zip [--include-models]
deepbom-review verify review.zip [--expected-sha256 HEX]
deepbom-review config --host copilot|vscode|gemini --workspace ABSOLUTE_DIRECTORY
deepbom-review mcp --workspace ABSOLUTE_DIRECTORY
deepbom-review engine-mcp --workspace ABSOLUTE_DIRECTORY

Writes never overwrite files. --workspace bounds all referenced paths.
run exit codes: 0 accept, 2 reject, 3 hold, 1 execution/input error.
verify reports integrity separately from the recorded candidate decision.
Evaluation records must be produced externally; this tool never trains or benchmarks.
See examples/ and README.md for fixed policies and measurement bindings.
`;
const command = process.argv[2];
const allowed = {
  capabilities: [],
  prepare: ['baseline', 'candidate', 'policy', 'change', 'out', 'baseline-evaluation', 'candidate-evaluation'],
  'import-evaluation': ['source', 'input', 'bindings', 'out'],
  run: ['out', 'include-models'], verify: ['expected-sha256'],
  config: ['host'], mcp: [], 'engine-mcp': [],
};
try {
  if (!command || command === '--help' || command === 'help') { console.log(help); }
  else {
    check(Object.hasOwn(allowed, command), `Unknown command: ${command}`);
    const options = Object.fromEntries([...allowed[command], 'workspace'].map(name => [name, { type: name === 'include-models' ? 'boolean' : 'string' }]));
    const { values, positionals } = parseArgs({ args: process.argv.slice(3), options, allowPositionals: true, strict: true });
    check(positionals.length === (['run', 'verify'].includes(command) ? 1 : 0), 'Unexpected or missing positional argument.');
    const args = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replaceAll('-', '_'), value]));
    const ctx = await context(args.workspace);
    let result;
    if (command === 'capabilities') result = capabilities;
    else if (command === 'prepare') result = await prepare(args, ctx);
    else if (command === 'import-evaluation') result = await importEvaluation(args, ctx);
    else if (command === 'run') {
      result = await runReview({ ...args, request: positionals[0] }, ctx);
      process.exitCode = { accept: 0, reject: 2, hold: 3 }[result.decision];
    } else if (command === 'verify') result = await verifyBundle({ ...args, bundle: positionals[0] }, ctx);
    else if (command === 'config') {
      check(ctx.root, 'An absolute --workspace is required.');
      check(['copilot', 'vscode', 'gemini'].includes(args.host), 'Host must be copilot, vscode or gemini.');
      const entry = fileURLToPath(import.meta.url);
      const server = cmd => ({ ...(args.host === 'copilot' ? { type: 'local', tools: ['*'] } : args.host === 'vscode' ? { type: 'stdio' } : {}), command: process.execPath, args: [entry, cmd, '--workspace', ctx.root] });
      result = { [args.host === 'vscode' ? 'servers' : 'mcpServers']: { deepbom: server('engine-mcp'), 'deepbom-review': server('mcp') } };
    } else if (command === 'engine-mcp') {
      check(ctx.root, 'An absolute --workspace is required.');
      process.chdir(ctx.root);
      delete process.env.DEEPBOM_MCP_ALLOWED_ROOTS;
      process.argv = [process.execPath, engineEntry, 'mcp'];
      await import(pathToFileURL(engineEntry).href);
    } else if (command === 'mcp') {
      check(ctx.root, 'An absolute --workspace is required.');
      process.chdir(ctx.root);
      const { serve } = await import('../lib/mcp.mjs');
      await serve(ctx);
    }
    if (result) process.stdout.write(jsonBytes(result));
  }
} catch (error) {
  process.stderr.write(`DEEPBOM Review: ${error.message}\n`);
  process.exitCode = 1;
}
