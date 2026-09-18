# DEEPBOM Review

Local candidate review for AI agents, Microsoft Olive and MLflow. **0.1.0 preview** uses the published **DEEPBOM 1.103.0** analyzer. An agent creates a candidate; this package checks its static evidence and externally measured results against a fixed policy, then saves an **accept / reject / hold** evidence ZIP.

The preview accepts same-format, single-file **ONNX with embedded weights** or **TFLite**, up to 128 MiB per model. It does not train, optimize, benchmark, execute model code, or deploy a model. Olive and your evaluator perform those jobs separately. Other artifact formats and multi-file models remain available in the general DEEPBOM analyzer but are outside this review workflow.

## Install

Requires Node.js 20+ on Windows, macOS or Linux. Install the versioned public GitHub package:

```sh
npm install -g github:JunHwan-Kwon/deepbom-review#v0.1.0
deepbom-review capabilities
```

Alternatively download [deepbom-review-0.1.0.zip](https://github.com/JunHwan-Kwon/deepbom-review/releases/tag/v0.1.0), compare its SHA-256 with `SHA256SUMS`, extract it, and run `node bin/deepbom-review.mjs --help`. The ZIP includes its npm dependencies and their licenses; no dependency download is needed for that path. Node.js is still required. This preview is distributed through GitHub, not a claimed npm registry or Microsoft marketplace listing.

## Connect GitHub Copilot

GitHub Copilot CLI and VS Code's Copilot agent support local MCP. This does not imply support in the Microsoft 365 or consumer Copilot apps.

Generate a configuration using the absolute model workspace path. All local files referenced by review requests, evaluation bindings and outputs must be inside that directory. Both the analyzer and the review MCP servers are included.

```sh
deepbom-review config --host copilot --workspace /absolute/model-workspace > deepbom-mcp.json
copilot --additional-mcp-config @deepbom-mcp.json
```

On Windows, use a quoted absolute path such as `"C:\Users\you\models"`. For VS Code:

```sh
deepbom-review config --host vscode --workspace /absolute/model-workspace
```

Copy the generated `servers` entries into `.vscode/mcp.json`, merging with any existing entries. Use **MCP: List Servers** to start them, then use Copilot's agent mode. For Gemini CLI, `--host gemini` emits `mcpServers` entries to merge into its settings. Other local MCP clients can launch `deepbom-review mcp --workspace ABSOLUTE_PATH`. Regenerate configs after moving the package or Node.js; generated commands use absolute executable paths. Host trust and tool permissions remain under your control.

Example agent request:

> Call deepbom_review_capabilities. Keep policy.json fixed. Inspect baseline.onnx and candidate.onnx with DEEPBOM. Use the supplied baseline and candidate evaluation receipts; do not invent measurements. Prepare the review request, build review-001.zip without model bytes, and explain its decision and missing evidence. Make at most three candidate revisions, retaining each package. Stop if criteria cannot be measured. Do not change the policy just to get an accept result.

Review tools: `deepbom_review_capabilities`, `deepbom_review_prepare`, `deepbom_review_import_evaluation`, `deepbom_review_build`, `deepbom_review_verify`. The four existing analyzer tools are exposed by the separate `deepbom` server. Write tools declare `readOnlyHint:false`; they never overwrite existing files. Reviews do not run commands from model metadata, result records or change descriptions.

Official host instructions: [Copilot CLI MCP](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers), [VS Code MCP](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

## First review

1. Copy `examples/policy.json` and choose your actual quality, latency and regression criteria **before** generating candidates. Example values are not recommendations. Keep this file under version control; requests pin its complete SHA-256. The package checks a request's fixed policy, but does not prove when the policy was authored or enforce policy continuity between independently created requests.
2. Let your existing agent or Olive generate `candidate.onnx` from `baseline.onnx`. Keep the original file.
3. Evaluate each artifact externally on the same dataset, evaluator code and environment. Import each result as described below.
4. Create and run a request:

```sh
deepbom-review prepare --baseline baseline.onnx --candidate candidate.onnx --policy policy.json --change "Describe the actual modification" --baseline-evaluation baseline.receipt.json --candidate-evaluation candidate.receipt.json --out request.json
deepbom-review run request.json --out review-001.zip
deepbom-review verify review-001.zip --expected-sha256 SHA256_PRINTED_BY_RUN
```

Without evaluation receipts, a valid structural review is saved with **hold**. Use `--include-models` on `run` only when you want the raw model files in the ZIP. Review exit codes are **0 accept, 2 reject, 3 hold, 1 input/execution error**. `verify` returns 0 for an internally consistent bundle regardless of its recorded candidate outcome.

## Bind external measurements

Each result binds four file hashes: **model**, **dataset manifest**, **evaluation code or code manifest**, and **environment descriptor**. Dataset and environment descriptors must be JSON objects; evaluator evidence is UTF-8 text. The receipts include these three evidence texts, their hashes and filenames, plus the source run record. Use a dataset manifest listing immutable members/hashes and a code manifest listing all relevant source files, dependency locks and revision identifiers when a single script is insufficient. The package hashes these descriptors; it does not traverse them or verify that the evaluator actually consumed every described member.

The environment should describe hardware/device, runtime and dependency versions, execution provider, precision, thread settings, warm-up, repetition count, and metric aggregation. Identical context hashes are required for direct baseline/candidate comparison in this preview. Metric units are explicit; no implicit milliseconds/seconds or percent/fraction conversion occurs. `max_regression` is an **absolute difference in the named unit**. Missing values, incomplete coverage or mismatched contexts cause hold; an established criterion failure causes reject, even if other checks are unknown.

The standard-library Python helper can capture bindings at evaluation time:

```python
from evidence_binding import capture_bindings  # adapters/evidence_binding.py

tags = capture_bindings(
    artifact="candidate.onnx",
    dataset="dataset-manifest.json",
    evaluator="evaluate.py",  # or an immutable code/dependency manifest
    environment="environment.json",
    metrics={
        "accuracy": {"key": "accuracy", "unit": "fraction"},
        "latency": {"key": "latency_ms", "unit": "ms"},
    },
    output="candidate.bindings.json",
)
```

Alternatively fill `examples/bindings.template.json` with **evaluation-time hashes**. Paths resolve relative to the bindings JSON. The producer statement is explicit: `these_files_were_used_for_this_evaluation`. Do not compute hashes of unrelated current files to repair a missing historical binding. If the measurement cannot be tied to a candidate, re-evaluate it or retain hold.

### MLflow

In the evaluator, call `capture_bindings` before inference and log the returned tags to that run:

```python
with mlflow.start_run():
    mlflow.set_tags(tags)
    # Run your real evaluator here, using the pinned inputs.
    mlflow.log_metric("accuracy", measured_accuracy)
    mlflow.log_metric("latency_ms", measured_latency_ms)
```

Export a completed run with the supplied read-only helper (requires MLflow installed and your own tracking connection):

```sh
python adapters/mlflow_export.py RUN_ID candidate.mlflow.json
deepbom-review import-evaluation --source mlflow --input candidate.mlflow.json --bindings candidate.bindings.json --out candidate.receipt.json
```

The importer accepts a native `Run.to_dictionary()` object or REST `{"run": ...}` response, with dictionary or REST-list metrics/tags. It requires `FINISHED` and exact `deepbom.artifact.sha256`, `deepbom.dataset.sha256`, `deepbom.evaluator.sha256`, `deepbom.environment.sha256` tags. It uses the run's final metric values; metric history is not re-aggregated. Do not reuse one run for different candidate files. After review, your own application can use `mlflow.log_artifact("review-001.zip")` and save its SHA-256 as a run tag. Review commands themselves do not upload anything.

See [MLflow Tracking](https://mlflow.org/docs/latest/ml/tracking/) and the executable integration example [test/integration_mlflow.py](test/integration_mlflow.py).

### Microsoft Olive

Run your Olive optimization/evaluation workflow, retain the produced models and its [`models_rank.json`](https://microsoft.github.io/Olive/how-to/configure-workflows/model-packaging.html). Select **one explicit rank** using `olive_rank` in the binding sidecar, and map native metric names to policy names:

```json
"olive_rank": 1,
"metrics": {
  "accuracy": {"key": "accuracy-accuracy", "unit": "fraction"},
  "latency": {"key": "latency-avg", "unit": "ms"}
}
```

```sh
deepbom-review import-evaluation --source olive --input models_rank.json --bindings candidate.bindings.json --out candidate.receipt.json
```

The selected entry's `model_config.type` must be `ONNXModel`, and `model_config.config.model_path` must resolve to the same pinned file. Relative native paths resolve from the rank file's directory. Use a sidecar containing bindings captured by your Olive evaluation integration; the native rank file does not itself provide the required full model/data/code/environment hashes. Its binding remains **producer-declared**. The importer does not rewrite Olive outputs, infer units, choose a rank automatically, or run optimization passes. Baseline measurements need a separate receipt on the same evaluation contexts. Unresolved paths or incomplete bindings require corrected evidence, not an assumed pass.

### Other evaluators

Use `--source generic` with a completed `deepbom.review.external_result.v1` JSON record:

```json
{
  "schema": "deepbom.review.external_result.v1",
  "run_id": "your-unique-run-id",
  "status": "completed",
  "artifact_sha256": "64-lowercase-hex-characters",
  "contexts": {
    "dataset": "dataset-manifest-sha256",
    "evaluator": "code-or-code-manifest-sha256",
    "environment": "environment-json-sha256"
  },
  "metrics": {"accuracy": 0.95, "latency_ms": 12.0}
}
```

These are illustrative measured values and placeholders, not benchmark results. Supply the same bindings sidecar and explicit metric mapping.

## What the ZIP preserves

`manifest.json` binds every member by SHA-256. The ZIP contains the original pinned request and policy, baseline/candidate envelopes, semantic diff, external receipts if supplied, decision checks and reasons, and `REPORT.md`. Raw models are optional. Source model files are snapshotted and rehashed; sidecars are not copied. Incomplete or failed analysis is preserved as unknown evidence and cannot become accept. All artifact defects, cautions and evidence gaps remain distinct. Input/output comparison includes names, order, dtype, shape and quantization; it does not establish preprocessing semantics or output label meaning.

`verify` checks all members and recomputes the decision **from supplied evidence**. It never extracts files, reruns analysis, or authenticates measurements. Archive hashes should be retained independently. A fully rewritten bundle can be internally consistent, so an unanchored bundle is not a cryptographic provenance attestation. The recorded accept/reject/hold is an application of your policy, not a production approval or proof that the model improved.

No telemetry or network calls are made by review commands. npm installation and the optional MLflow export helper have their own network connections. The separate general analyzer MCP can retrieve explicitly requested immutable remote artifacts. MCP results enter the AI host conversation. Bundles include evaluation code/manifests, environment descriptions, source run records, and possibly local paths or parameters; inspect them before sharing. Dataset contents are not gathered automatically. Inputs under adversarial concurrent filesystem modification are outside the preview's threat model; symlink and transitive path escapes are checked at use time.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run package
```

See [VALIDATION.md](VALIDATION.md) for coverage and untested host paths. The source fixtures are small, original synthetic models, reproducible with `test/generate-fixtures.py`. No private DEEPBOM repository history is included.
