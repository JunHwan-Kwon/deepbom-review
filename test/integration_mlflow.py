"""Real ONNX Runtime inference -> local MLflow -> review ZIP integration check.

Uses original tiny test models and a synthetic four-example dataset. It is a
transport/integrity test, not a model-quality benchmark or an optimization claim.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time
import mlflow
from mlflow import MlflowClient
import numpy as np
import onnxruntime as ort

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "adapters"))
from evidence_binding import capture_bindings

with tempfile.TemporaryDirectory(prefix="deepbom-mlflow-") as work:
    work = Path(work)
    dataset = work / "dataset.json"
    dataset.write_text(json.dumps({"inputs": [[1, 2], [3, 1], [-1, 2], [2, -1]], "labels": [1, 0, 1, 0]}))
    environment = work / "environment.json"
    environment.write_text(json.dumps({"python": platform.python_version(), "platform": platform.platform(),
        "onnxruntime": ort.__version__, "numpy": np.__version__, "provider": "CPUExecutionProvider", "threads": 1,
        "warmup": 3, "repeats": 20, "metric": "top-1 accuracy"}))
    uri = "sqlite:///" + str(work / "mlflow.db")
    os.environ["MLFLOW_TRACKING_URI"] = uri
    client = MlflowClient(tracking_uri=uri)
    experiment = client.create_experiment("deepbom-review-integration", artifact_location=str(work / "artifacts"))
    node = os.environ.get("NODE", "node")
    cli = [node, str(root / "bin" / "deepbom-review.mjs")]
    def run(*args):
        completed = subprocess.run([*cli, *map(str,args)], capture_output=True, text=True, check=True)
        return json.loads(completed.stdout)
    receipts = {}
    for role in ["baseline", "candidate"]:
        artifact = root / "test" / "fixtures" / f"{role}.onnx"
        bindings = work / f"{role}.bindings.json"
        tags = capture_bindings(artifact=artifact, dataset=dataset, evaluator=__file__, environment=environment,
            metrics={"accuracy": {"key": "accuracy", "unit": "fraction"}, "latency": {"key": "latency_ms", "unit": "ms"}}, output=bindings)
        started = client.create_run(experiment, tags=tags)
        options = ort.SessionOptions(); options.intra_op_num_threads = 1; options.inter_op_num_threads = 1
        session = ort.InferenceSession(str(artifact), sess_options=options, providers=["CPUExecutionProvider"])
        data = json.loads(dataset.read_text())
        correct = 0
        for value, label in zip(data["inputs"], data["labels"]):
            prediction = session.run(None, {"input": np.asarray([value], dtype=np.float32)})[0]
            correct += int(np.argmax(prediction) == label)
        inputs = {"input": np.asarray([data["inputs"][0]], dtype=np.float32)}
        for _ in range(3): session.run(None, inputs)
        start = time.perf_counter()
        for _ in range(20): session.run(None, inputs)
        latency = (time.perf_counter() - start) * 1000 / 20
        client.log_metric(started.info.run_id, "accuracy", correct / len(data["labels"]))
        client.log_metric(started.info.run_id, "latency_ms", latency)
        client.set_terminated(started.info.run_id, status="FINISHED")
        source = work / f"{role}.mlflow.json"
        subprocess.run([sys.executable, str(root / "adapters" / "mlflow_export.py"), started.info.run_id, str(source)], check=True)
        receipts[role] = work / f"{role}.receipt.json"
        run("import-evaluation", "--source", "mlflow", "--input", source, "--bindings", bindings, "--out", receipts[role])
    policy = json.loads((root / "examples" / "policy.json").read_text())
    # Runtime latency is recorded but intentionally not gated in this portable
    # integration test, since host scheduling makes it nondeterministic.
    policy["metrics"] = policy["metrics"][:1]
    policy_path = work / "policy.json"; policy_path.write_text(json.dumps(policy))
    request = work / "request.json"
    run("prepare", "--baseline", root/"test/fixtures/baseline.onnx", "--candidate", root/"test/fixtures/candidate.onnx",
        "--policy", policy_path, "--change", "Synthetic test: weights scaled, class ranking preserved on four examples.",
        "--baseline-evaluation", receipts["baseline"], "--candidate-evaluation", receipts["candidate"], "--out", request)
    result = run("run", request, "--out", work/"review.zip")
    assert result["decision"] == "accept", result
    verified = run("verify", work/"review.zip", "--expected-sha256", result["sha256"])
    assert verified["integrity"] == "verified"
    print(json.dumps({"mlflow": mlflow.__version__, "onnxruntime": ort.__version__, "decision": result["decision"],
        "real_inference": True, "synthetic_dataset": True, "bundle_verified": True}))
