import path from 'node:path';
import fs from 'node:fs/promises';
import { check, keys, object, sha, readJson, pinFile, jsonBytes, writeNew, digest, MAX_JSON } from './io.mjs';

export const RECEIPT_SCHEMA = 'deepbom.review.evaluation.v1';
export const BOUNDARY = 'Producer-declared external measurements. Hashes bind supplied files and records, but do not prove that evaluation ran, used those inputs, or produced truthful metrics.';
const CONTEXTS = ['dataset', 'evaluator', 'environment'];

export function validateReceipt(r) {
  keys(r, ['schema', 'source', 'artifact_sha256', 'contexts', 'metrics', 'evidence_boundary'], 'evaluation');
  check(r.schema === RECEIPT_SCHEMA, 'Unsupported evaluation receipt schema.');
  sha(r.artifact_sha256);
  check(r.evidence_boundary === BOUNDARY, 'Missing external measurement evidence boundary.');
  keys(r.contexts, CONTEXTS, 'evaluation contexts');
  for (const name of CONTEXTS) {
    keys(r.contexts[name], ['sha256', 'byte_length', 'file_name', 'content'], name);
    sha(r.contexts[name].sha256);
    check(Number.isSafeInteger(r.contexts[name].byte_length) && r.contexts[name].byte_length >= 0, `Invalid ${name} length.`);
    check(typeof r.contexts[name].file_name === 'string' && typeof r.contexts[name].content === 'string', `Missing ${name} evidence text.`);
    const bytes = Buffer.from(r.contexts[name].content);
    check(digest(bytes) === r.contexts[name].sha256 && bytes.length === r.contexts[name].byte_length, `${name} content does not match its binding.`);
  }
  object(r.metrics, 'metrics');
  check(Object.keys(r.metrics).length > 0, 'Evaluation has no metrics.');
  for (const [name, metric] of Object.entries(r.metrics)) {
    check(/^[a-z][a-z0-9_]{0,63}$/.test(name), 'Metric names must be simple lowercase identifiers.');
    keys(metric, ['value', 'unit'], 'metric');
    check(Number.isFinite(metric.value), `Metric ${name} must be finite.`);
    check(typeof metric.unit === 'string' && metric.unit.length > 0 && metric.unit.length < 80, `Metric ${name} needs an explicit unit.`);
  }
  keys(r.source, ['kind', 'sha256', 'record_id', 'record'], 'evaluation source');
  check(['olive', 'mlflow', 'generic'].includes(r.source.kind), 'Unsupported evaluation source.');
  sha(r.source.sha256);
  check(typeof r.source.record_id === 'string' && r.source.record_id.length > 0, 'Evaluation source needs a record identifier.');
  object(r.source.record, 'source record');
  return r;
}

function entries(value, field = 'value') {
  if (!Array.isArray(value)) return object(value ?? {}, 'MLflow data');
  const result = Object.create(null);
  for (const row of value) {
    check(typeof row.key === 'string' && !Object.hasOwn(result, row.key), 'Duplicate or invalid MLflow key.');
    result[row.key] = row[field];
  }
  return result;
}

export async function importEvaluation({ source, input, bindings, out }, ctx = {}) {
  check(['olive', 'mlflow', 'generic'].includes(source), 'Source must be olive, mlflow, or generic.');
  const raw = await readJson(input, process.cwd(), ctx);
  const bindingFile = await readJson(bindings, process.cwd(), ctx);
  const b = bindingFile.value;
  keys(b, ['schema', 'artifact', 'dataset', 'evaluator', 'environment', 'metrics', 'olive_rank', 'producer_statement'], 'bindings');
  check(b.schema === 'deepbom.review.bindings.v1', 'Unsupported bindings schema.');
  check(b.producer_statement === 'these_files_were_used_for_this_evaluation', 'The evaluation producer must explicitly attest the file bindings.');
  const base = path.dirname(bindingFile.path);
  const artifact = await pinFile(b.artifact, base, ctx);
  const contexts = {};
  for (const name of CONTEXTS) {
    const pinned = await pinFile(b[name], base, ctx, MAX_JSON);
    const bytes = await fs.readFile(pinned.path);
    check(digest(bytes) === pinned.sha256, `${name} changed while importing.`);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (name !== 'evaluator') object(JSON.parse(content), `${name} JSON descriptor`);
    contexts[name] = { sha256: pinned.sha256, byte_length: pinned.byte_length, file_name: path.basename(pinned.path), content };
  }
  let values, recordId, record;
  if (source === 'olive') {
    check(Array.isArray(raw.value), 'Olive input must be models_rank.json (an array).');
    check(Number.isSafeInteger(b.olive_rank) && b.olive_rank > 0, 'Select an explicit olive_rank.');
    const selected = raw.value.filter(row => row.rank === b.olive_rank);
    check(selected.length === 1, 'Olive rank is missing or ambiguous.');
    record = selected[0];
    check(record.model_config?.type?.toLowerCase() === 'onnxmodel', 'Olive preview supports a single ONNXModel.');
    // A model path is not a digest. The sidecar is an explicit producer assertion;
    // the native path still has to resolve to the same local file.
    const oliveModel = await pinFile({ path: record.model_config.config.model_path, sha256: artifact.sha256 }, path.dirname(raw.path), ctx);
    check(oliveModel.path === artifact.path, 'Olive rank selects a different model file.');
    values = Object.fromEntries(Object.entries(object(record.metrics, 'Olive metrics')).map(([key, metric]) => [key, metric.value]));
    recordId = `rank:${b.olive_rank}`;
  } else if (source === 'mlflow') {
    record = raw.value.run ?? raw.value;
    check(record.info?.status === 'FINISHED', 'MLflow run must have FINISHED status.');
    recordId = record.info.run_id;
    check(typeof recordId === 'string' && recordId.length > 0, 'MLflow run_id is required.');
    const tags = entries(record.data?.tags);
    for (const [key, value] of Object.entries({ 'deepbom.artifact.sha256': artifact.sha256,
      ...Object.fromEntries(CONTEXTS.map(name => [`deepbom.${name}.sha256`, contexts[name].sha256])) })) {
      check(tags[key] === value, `Missing or mismatched MLflow binding tag: ${key}`);
    }
    values = entries(record.data?.metrics);
  } else {
    record = object(raw.value, 'generic result');
    keys(record, ['schema', 'run_id', 'artifact_sha256', 'contexts', 'metrics', 'status'], 'generic result');
    check(record.schema === 'deepbom.review.external_result.v1' && record.status === 'completed', 'Generic result must be a completed external_result.v1 record.');
    check(record.artifact_sha256 === artifact.sha256, 'Generic result artifact binding mismatch.');
    for (const name of CONTEXTS) check(record.contexts?.[name] === contexts[name].sha256, `Generic ${name} binding mismatch.`);
    recordId = record.run_id;
    values = object(record.metrics, 'generic metrics');
  }
  const metrics = Object.create(null);
  object(b.metrics, 'metric mapping');
  for (const [name, mapping] of Object.entries(b.metrics)) {
    keys(mapping, ['key', 'unit'], 'metric mapping');
    check(typeof mapping.key === 'string' && Object.hasOwn(values, mapping.key), `Missing source metric: ${mapping.key}`);
    metrics[name] = { value: values[mapping.key], unit: mapping.unit };
  }
  const receipt = validateReceipt({ schema: RECEIPT_SCHEMA, source: { kind: source, sha256: raw.sha256, record_id: recordId, record },
    artifact_sha256: artifact.sha256, contexts, metrics, evidence_boundary: BOUNDARY });
  const receiptBytes = jsonBytes(receipt);
  check(receiptBytes.length <= MAX_JSON, 'Combined evaluation receipt exceeds 8 MiB; use compact dataset/code manifests.');
  await writeNew(out, receiptBytes, ctx);
  return { path: path.resolve(out), schema: receipt.schema, artifact_sha256: artifact.sha256, source, evidence_boundary: BOUNDARY };
}
