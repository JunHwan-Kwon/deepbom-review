import { check, keys } from './io.mjs';
import { validateReceipt, BOUNDARY } from './evaluation.mjs';

export function validatePolicy(p) {
  keys(p, ['schema', 'id', 'preserve_interfaces', 'required_capabilities', 'metrics'], 'policy');
  check(p.schema === 'deepbom.review.policy.v1', 'Unsupported review policy schema.');
  check(typeof p.id === 'string' && p.id.length > 0, 'Policy id is required.');
  check(p.preserve_interfaces === true, 'Preview requires preserve_interfaces=true.');
  check(Array.isArray(p.required_capabilities) && p.required_capabilities.every(x => typeof x === 'string'), 'required_capabilities must be an array of names.');
  check(Array.isArray(p.metrics) && p.metrics.length > 0, 'At least one fixed evaluation criterion is required.');
  const names = new Set();
  for (const metric of p.metrics) {
    keys(metric, ['name', 'unit', 'direction', 'threshold', 'max_regression'], 'policy metric');
    check(typeof metric.name === 'string' && !names.has(metric.name), 'Policy metric names must be unique.');
    names.add(metric.name);
    check(typeof metric.unit === 'string' && metric.unit.length > 0, 'Policy metric unit is required.');
    check(['higher', 'lower'].includes(metric.direction), 'Metric direction must be higher or lower.');
    check(Number.isFinite(metric.threshold), 'Metric threshold must be finite.');
    check(Number.isFinite(metric.max_regression) && metric.max_regression >= 0, 'max_regression must be a nonnegative absolute difference in the metric unit.');
  }
  return p;
}
function contracts(envelope) {
  return (envelope.interfaces?.parameters ?? []).map(p => ({ direction: p.direction, ordinal: p.ordinal,
    name: p.tensor_name, dtype: p.dtype, shape: p.shape, shape_signature: p.shape_signature,
    quantization: Object.fromEntries(['status', 'scheme', 'granularity', 'parameterization', 'scales', 'zero_points', 'axis', 'block_size'].map(key => [key, p.quantization?.[key] ?? null]))
  })).sort((a,b) => a.direction.localeCompare(b.direction) || a.ordinal-b.ordinal);
}
// Compare the JSON numbers' shortest decimal representations exactly. This
// keeps an inclusive 0.01 regression limit from rejecting 0.95 -> 0.94 solely
// because binary floating point subtraction yields 0.010000000000000009.
function regressionExceeds(before, after, allowed, higher) {
  const parts = [before, after, allowed].map(value => {
    const [mantissa, exponent = '0'] = value.toString().toLowerCase().split('e');
    const fractional = mantissa.split('.')[1]?.length ?? 0;
    return { n: BigInt(mantissa.replace('.', '')), e: Number(exponent) - fractional };
  });
  const scale = Math.min(...parts.map(p => p.e));
  const [a,b,limit] = parts.map(p => p.n * 10n ** BigInt(p.e - scale));
  return (higher ? a - b : b - a) > limit;
}
export function decide({ policy, baseline, candidate, diff, baselineEvaluation, candidateEvaluation }) {
  validatePolicy(policy);
  const checks = [];
  const add = (id, state, reason, evidence = {}) => checks.push({ id, state, reason, ...evidence });
  const defects = (candidate.findings ?? []).filter(f => f.finding_kind === 'artifact_defect');
  add('candidate_defects', candidate.analysis_error ? 'unknown' : defects.length ? 'fail' : 'pass', candidate.analysis_error ? 'Candidate analysis failed; defect absence is not established.' : `${defects.length} candidate artifact defects observed.`, { findings: defects.map(f => f.id) });
  if (diff) add('semantic_comparison', diff.analysis_error ? 'unknown' : 'pass', diff.analysis_error ? 'Semantic comparison could not complete; see diff.json.' : 'Hash-bound semantic comparison completed.');
  for (const [role, envelope] of Object.entries({ baseline, candidate })) {
    add(`${role}_analysis`, envelope.analysis_error ? 'unknown' : 'pass', envelope.analysis_error ? 'Static analysis could not complete; see the stored error record.' : 'Static analysis completed.');
    const files = envelope.artifact_set?.files;
    const closure = Array.isArray(files) && files.length === 1 && Array.isArray(envelope.external_files) && envelope.external_files.length === 0;
    add(`${role}_single_file`, closure ? 'pass' : 'unknown', closure ? 'Single-file evidence closure.' : 'External or incomplete artifact closure is outside this preview.');
    for (const capability of new Set(['artifact_identity', 'graph', 'interfaces', ...policy.required_capabilities])) {
      const status = ['assessed', 'partial', 'unavailable'].find(s => envelope.capabilities?.[s]?.includes(capability));
      add(`${role}_coverage_${capability}`, status === 'assessed' ? 'pass' : 'unknown', `${capability}: ${status ?? 'missing'}`);
    }
  }
  const a = contracts(baseline), b = contracts(candidate);
  const complete = a.length > 0 && b.length > 0 && baseline.interfaces?.invalid_or_incomplete_parameter_count === 0 && candidate.interfaces?.invalid_or_incomplete_parameter_count === 0;
  add('interface_preservation', !complete ? 'unknown' : JSON.stringify(a) === JSON.stringify(b) ? 'pass' : 'fail', !complete ? 'Input/output contracts are incomplete.' : 'Compare names, order, dtypes, shapes and quantization; this does not establish preprocessing or label semantics.', { baseline: a, candidate: b });
  let comparable = true;
  for (const [role, receipt, envelope] of [['baseline', baselineEvaluation, baseline], ['candidate', candidateEvaluation, candidate]]) {
    let issue = null;
    try { validateReceipt(receipt); check(receipt.artifact_sha256 === envelope.identity.sha256, 'Receipt belongs to different model bytes.'); }
    catch (error) { issue = error.message; comparable = false; }
    add(`${role}_evaluation_binding`, issue ? 'unknown' : 'pass', issue ?? 'External receipt matches the exact artifact hash.');
  }
  if (comparable) for (const name of ['dataset', 'evaluator', 'environment']) {
    const same = baselineEvaluation.contexts[name].sha256 === candidateEvaluation.contexts[name].sha256;
    if (!same) comparable = false;
    add(`comparable_${name}`, same ? 'pass' : 'unknown', same ? `Identical ${name} binding.` : `Different ${name} bindings; direct comparison is not established.`);
  }
  for (const metric of policy.metrics) {
    const before = baselineEvaluation?.metrics?.[metric.name], after = candidateEvaluation?.metrics?.[metric.name];
    if (!comparable || !before || !after || before.unit !== metric.unit || after.unit !== metric.unit) {
      add(`metric_${metric.name}`, 'unknown', 'Comparable measurements with the exact policy unit are required.');
      continue;
    }
    const higher = metric.direction === 'higher';
    const thresholdPass = higher ? after.value >= metric.threshold : after.value <= metric.threshold;
    const regression = higher ? before.value - after.value : after.value - before.value;
    add(`metric_${metric.name}`, thresholdPass && !regressionExceeds(before.value, after.value, metric.max_regression, higher) ? 'pass' : 'fail', 'Evaluate the fixed absolute threshold and inclusive maximum regression using the supplied decimal values.',
      { baseline: before.value, candidate: after.value, unit: metric.unit, threshold: metric.threshold, max_regression: metric.max_regression, regression: Number.isFinite(regression) ? regression : String(regression) });
  }
  const status = checks.some(c => c.state === 'fail') ? 'reject' : checks.some(c => c.state === 'unknown') ? 'hold' : 'accept';
  return { schema: 'deepbom.review.decision.v1', status, policy_id: policy.id, checks,
    scope: 'Satisfaction of the supplied candidate-review policy; not autonomous deployment approval or proof of model improvement.',
    evidence_boundary: BOUNDARY,
    findings: { baseline: baseline.findings ?? [], candidate: candidate.findings ?? [] } };
}
