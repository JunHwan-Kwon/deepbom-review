"""Export a completed MLflow run to JSON for DEEPBOM Review (read-only).

Usage: python mlflow_export.py RUN_ID run.json
Uses the caller's configured MLFLOW_TRACKING_URI and credentials. No credentials
are copied into the output by this script; MLflow run tags/params may contain
sensitive values. Inspect the exported file before sharing a review bundle.
"""
import json
import sys
from mlflow import MlflowClient

if len(sys.argv) != 3:
    raise SystemExit("Usage: python mlflow_export.py RUN_ID run.json")
run = MlflowClient().get_run(sys.argv[1])
if run.info.status != "FINISHED":
    raise SystemExit("Run must have FINISHED status.")
required = [f"deepbom.{kind}.sha256" for kind in ["artifact", "dataset", "evaluator", "environment"]]
if any(key not in run.data.tags for key in required):
    raise SystemExit("Missing evaluation-time SHA-256 tags: " + ", ".join(required))
with open(sys.argv[2], "x", encoding="utf-8") as stream:
    json.dump({"run": run.to_dictionary()}, stream, indent=2)
    stream.write("\n")
