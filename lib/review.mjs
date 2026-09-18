import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { check, keys, sha, readJson, pinFile, hashFile, jsonBytes, digest, writeNew, inputPath, outputPath, MAX_JSON, MAX_MODEL } from './io.mjs';
import { engine, engineVersion } from './engine.mjs';
import { decide, validatePolicy } from './decision.mjs';

export const version = '0.1.0';
export const capabilities = {
  schema: 'deepbom.review.capabilities.v1', version, engine_version: engineVersion,
  formats: ['onnx', 'tflite'], scope: 'Single-file local baseline/candidate review; embedded weights only.',
  outcomes: ['accept', 'reject', 'hold'], evaluation_sources: ['olive', 'mlflow', 'generic'],
  execution: 'Static analysis only. The caller generates candidates and executes measurements externally.',
  privacy: 'No network requests or telemetry from review commands. Bundles may contain local paths, metadata and external run records. Returned MCP summaries enter the host conversation.',
  limits: { model_bytes: MAX_MODEL, json_bytes: MAX_JSON },
  interpretation: 'accept means the supplied fixed policy passed on the supplied evidence. It is not proof of improvement, clinical validity, production readiness or regulatory compliance.',
};
export async function prepare({ baseline, candidate, policy, change, out, baseline_evaluation, candidate_evaluation }, ctx = {}) {
  check(typeof change === 'string' && change.trim().length > 0 && change.length <= 10000, 'A nonempty change description is required (at most 10,000 characters).');
  const output = await outputPath(out, ctx);
  const base = path.dirname(output);
  const bind = async p => {
    const full = await inputPath(p, process.cwd(), ctx);
    return { path: path.relative(base, full), sha256: (await hashFile(full)).sha256 };
  };
  const pol = await readJson(policy, process.cwd(), ctx);
  validatePolicy(pol.value);
  const request = { schema: 'deepbom.review.request.v1', change, policy: await bind(policy), baseline: await bind(baseline), candidate: await bind(candidate) };
  if (baseline_evaluation) request.baseline_evaluation = await bind(baseline_evaluation);
  if (candidate_evaluation) request.candidate_evaluation = await bind(candidate_evaluation);
  await writeNew(output, jsonBytes(request), ctx);
  return { path: output, ...request };
}

function validateRequest(r) {
  keys(r, ['schema', 'change', 'policy', 'baseline', 'candidate', 'baseline_evaluation', 'candidate_evaluation'], 'request');
  check(r.schema === 'deepbom.review.request.v1', 'Unsupported review request schema.');
  check(typeof r.change === 'string' && r.change.trim().length > 0 && r.change.length <= 10000, 'Change description is required and must be at most 10,000 characters.');
}
function report(r, decision, policy, identity) {
  return `# DEEPBOM candidate review\n\nDecision: **${decision.status}**\n\n${decision.scope}\n\n` +
    `Change description (caller supplied):\n\n${r.change}\n\n` +
    `Baseline SHA-256: ${identity.baseline.sha256}\n\nCandidate SHA-256: ${identity.candidate.sha256}\n\nPolicy SHA-256: ${policy.sha256}\n\n` +
    decision.checks.map(c => `- ${c.state.toUpperCase()} ${c.id}: ${c.reason}`).join('\n') +
    `\n\nAll findings are retained in decision.json and the artifact envelopes. Cautions and evidence gaps are not relabeled as defects.\n\n${decision.evidence_boundary}\n\n` +
    `No model code was executed by this review. Model bytes are optional bundle entries. Integrity verification does not establish authenticity; retain the ZIP SHA-256 independently.\n`;
}

export async function runReview({ request, out, include_models = false }, ctx = {}) {
  check(typeof include_models === 'boolean', 'include_models must be boolean.');
  await outputPath(out, ctx);
  const req = await readJson(request, process.cwd(), ctx);
  validateRequest(req.value);
  const r = req.value, base = path.dirname(req.path);
  const pol = await pinFile(r.policy, base, ctx, MAX_JSON);
  const policyFile = await readJson(pol.path, base, ctx);
  check(policyFile.sha256 === pol.sha256, 'Policy changed while being read.');
  validatePolicy(policyFile.value);
  const pinned = {};
  for (const role of ['baseline', 'candidate']) pinned[role] = await pinFile(r[role], base, ctx);
  const format = path.extname(pinned.baseline.path).slice(1).toLowerCase();
  check(['onnx', 'tflite'].includes(format) && path.extname(pinned.candidate.path).slice(1).toLowerCase() === format, 'Preview requires same-format .onnx or .tflite single files.');
  const evaluations = {};
  for (const role of ['baseline', 'candidate']) if (r[`${role}_evaluation`]) {
    const file = await pinFile(r[`${role}_evaluation`], base, ctx, MAX_JSON);
    evaluations[role] = await readJson(file.path, base, ctx);
    check(evaluations[role].sha256 === file.sha256, 'Evaluation changed while being read.');
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'deepbom-review-'));
  const snapshots = {};
  const members = new Map();
  try {
    // Isolated single-file snapshots prevent sibling sidecars from being silently
    // included. Their absence is represented by envelope coverage and findings.
    for (const role of ['baseline', 'candidate']) {
      const dir = path.join(temp, role);
      await fs.mkdir(dir);
      snapshots[role] = path.join(dir, `model.${format}`);
      await fs.copyFile(pinned[role].path, snapshots[role]);
      check((await hashFile(snapshots[role])).sha256 === pinned[role].sha256, 'Artifact changed while taking the analysis snapshot.');
    }
    const envelopes = {};
    for (const role of ['baseline', 'candidate']) {
      try {
        envelopes[role] = await engine(['audit', snapshots[role], '--scan', 'full', '--expected-sha256', pinned[role].sha256, '--output-format', 'envelope'], temp, ctx.signal);
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        envelopes[role] = { schema: 'deepbom.review.analysis_failure.v1', identity: { sha256: pinned[role].sha256, format, byte_length: pinned[role].byte_length },
          analysis_error: String(error.stderr || error.message).slice(0, 4000), capabilities: { assessed: ['artifact_identity'], partial: [], unavailable: ['graph','interfaces','tensor_payloads'] },
          findings: [], interfaces: null, artifact_set: null, external_files: null };
      }
      check(envelopes[role].identity?.sha256 === pinned[role].sha256 && envelopes[role].identity?.format === format, 'Engine returned an unexpected artifact identity.');
    }
    let diff;
    try { diff = await engine(['diff', snapshots.baseline, snapshots.candidate, '--compact'], temp, ctx.signal); }
    catch (error) {
      if (ctx.signal?.aborted) throw error;
      diff = { schema: 'deepbom.review.diff_failure.v1', baseline: { sha256: pinned.baseline.sha256 }, candidate: { sha256: pinned.candidate.sha256 },
        analysis_error: String(error.stderr || error.message).slice(0, 4000) };
    }
    check(diff.baseline?.sha256 === pinned.baseline.sha256 && diff.candidate?.sha256 === pinned.candidate.sha256, 'Diff identity mismatch.');
    const decision = decide({ policy: policyFile.value, ...envelopes, diff, baselineEvaluation: evaluations.baseline?.value, candidateEvaluation: evaluations.candidate?.value });
    members.set('request.json', req.bytes);
    members.set('policy.json', policyFile.bytes);
    members.set('baseline.envelope.json', jsonBytes(envelopes.baseline));
    members.set('candidate.envelope.json', jsonBytes(envelopes.candidate));
    members.set('diff.json', jsonBytes(diff));
    members.set('decision.json', jsonBytes(decision));
    members.set('REPORT.md', Buffer.from(report(r, decision, policyFile, pinned)));
    for (const role of ['baseline', 'candidate']) {
      if (evaluations[role]) members.set(`${role}.evaluation.json`, evaluations[role].bytes);
      if (include_models) members.set(`models/${role}.${format}`, await fs.readFile(snapshots[role]));
      check((await hashFile(pinned[role].path)).sha256 === pinned[role].sha256, 'Source artifact changed during review.');
    }
    const manifest = { schema: 'deepbom.review.bundle.v1', review_version: version, engine_version: engineVersion,
      created_at: new Date().toISOString(), request_sha256: req.sha256, policy_sha256: policyFile.sha256,
      artifacts: Object.fromEntries(Object.entries(pinned).map(([role, p]) => [role, { sha256: p.sha256, byte_length: p.byte_length, format }])),
      decision: decision.status, models_included: include_models,
      files: [...members].map(([name, bytes]) => ({ name, sha256: digest(bytes), byte_length: bytes.length })) };
    members.set('manifest.json', jsonBytes(manifest));
    let unpacked = 0;
    for (const [name, data] of members) {
      check(data.length <= (name.startsWith('models/') ? MAX_MODEL : 32 * 1024 * 1024), 'Evidence member exceeds the supported size limit.');
      unpacked += data.length;
    }
    check(unpacked <= 300 * 1024 * 1024, 'Evidence bundle exceeds the supported size limit.');
    const zip = new AdmZip();
    for (const [name, bytes] of members) zip.addFile(name, bytes);
    const bytes = zip.toBuffer();
    check(bytes.length <= 300 * 1024 * 1024, 'Evidence bundle exceeds the supported size limit.');
    check(!ctx.signal?.aborted, 'Review cancelled before writing.');
    const filename = await writeNew(out, bytes, ctx);
    return { schema: 'deepbom.review.result.v1', decision: decision.status, bundle: filename, sha256: digest(bytes),
      policy_sha256: policyFile.sha256, artifacts: manifest.artifacts, checks: decision.checks.map(({ id, state, reason }) => ({ id, state, reason })), scope: decision.scope };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

export async function verifyBundle({ bundle, expected_sha256 }, ctx = {}) {
  const filename = await inputPath(bundle, process.cwd(), ctx);
  const size = (await fs.stat(filename)).size;
  check(size <= 300 * 1024 * 1024, 'Bundle exceeds the 300 MiB limit.');
  const bytes = await fs.readFile(filename);
  const actual = digest(bytes);
  if (expected_sha256) check(actual === sha(expected_sha256), 'Bundle SHA-256 differs from the independently expected digest.');
  const zip = new AdmZip(bytes);
  const entries = zip.getEntries();
  check(entries.length >= 8 && entries.length <= 12, 'Unexpected bundle member count.');
  const names = new Set();
  let total = 0;
  for (const entry of entries) {
    check(!entry.isDirectory && /^(manifest\.json|request\.json|policy\.json|(?:baseline|candidate)\.(?:envelope|evaluation)\.json|diff\.json|decision\.json|REPORT\.md|models\/(?:baseline|candidate)\.(?:onnx|tflite))$/.test(entry.entryName), 'Unexpected or unsafe bundle member.');
    check(!names.has(entry.entryName), 'Duplicate bundle member.');
    names.add(entry.entryName);
    check(entry.header.size <= (entry.entryName.startsWith('models/') ? MAX_MODEL : 32 * 1024 * 1024), 'Bundle member exceeds its size limit.');
    total += entry.header.size;
  }
  check(total <= 300 * 1024 * 1024, 'Bundle exceeds the unpacked size limit.');
  const get = name => { check(names.has(name), `Missing bundle member: ${name}`); return zip.readFile(name); };
  const parse = name => JSON.parse(get(name).toString('utf8'));
  const manifest = parse('manifest.json');
  check(manifest.schema === 'deepbom.review.bundle.v1' && manifest.review_version === version && manifest.engine_version === engineVersion, 'Unsupported bundle version.');
  check(typeof manifest.models_included === 'boolean', 'Invalid model inclusion flag.');
  check(Array.isArray(manifest.files) && manifest.files.length === entries.length - 1, 'Manifest member count mismatch.');
  const covered = new Set();
  for (const file of manifest.files) {
    check(file.name !== 'manifest.json' && !covered.has(file.name), 'Duplicate or self-referencing manifest member.');
    covered.add(file.name);
    const data = get(file.name);
    check(digest(data) === sha(file.sha256) && data.length === file.byte_length, 'Bundle member integrity mismatch.');
  }
  const req = parse('request.json');
  validateRequest(req);
  check(manifest.request_sha256 === digest(get('request.json')) && manifest.policy_sha256 === digest(get('policy.json')) && req.policy.sha256 === manifest.policy_sha256, 'Policy/request binding mismatch.');
  const envelopes = {};
  const evals = {};
  const expected = new Set(['manifest.json','request.json','policy.json','baseline.envelope.json','candidate.envelope.json','diff.json','decision.json','REPORT.md']);
  for (const role of ['baseline', 'candidate']) {
    envelopes[role] = parse(`${role}.envelope.json`);
    const artifact = manifest.artifacts?.[role];
    check(['onnx','tflite'].includes(artifact?.format), 'Unsupported bundled artifact format.');
    check(artifact?.sha256 === req[role].sha256 && artifact.sha256 === envelopes[role].identity?.sha256 && artifact.format === envelopes[role].identity?.format, 'Artifact binding mismatch.');
    if (req[`${role}_evaluation`]) {
      expected.add(`${role}.evaluation.json`);
      const data = get(`${role}.evaluation.json`);
      check(digest(data) === req[`${role}_evaluation`].sha256, 'Evaluation binding mismatch.');
      evals[role] = JSON.parse(data.toString('utf8'));
    } else check(!names.has(`${role}.evaluation.json`), 'Unbound evaluation receipt.');
    const modelName = `models/${role}.${artifact.format}`;
    if (manifest.models_included) { expected.add(modelName); check(digest(get(modelName)) === artifact.sha256, 'Included model hash mismatch.'); }
    else check(![...names].some(n => n.startsWith('models/')), 'Unexpected model bytes.');
  }
  check(expected.size === names.size && [...expected].every(name => names.has(name)), 'Unexpected or missing bound bundle members.');
  const diff = parse('diff.json');
  check(diff.baseline?.sha256 === req.baseline.sha256 && diff.candidate?.sha256 === req.candidate.sha256, 'Diff binding mismatch.');
  const recomputed = decide({ policy: parse('policy.json'), ...envelopes, diff, baselineEvaluation: evals.baseline, candidateEvaluation: evals.candidate });
  const recorded = parse('decision.json');
  check(JSON.stringify(recomputed) === JSON.stringify(recorded) && manifest.decision === recorded.status, 'Recorded decision differs from supplied evidence and policy.');
  return { schema: 'deepbom.review.verification.v1', integrity: 'verified', decision_recomputed: true, decision: recorded.status, sha256: actual,
    independently_pinned: Boolean(expected_sha256), boundary: 'Checks internal consistency and re-evaluates the supplied evidence. Does not re-run the analyzer or external measurements, or prove authenticity.' };
}
