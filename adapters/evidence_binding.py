"""Capture local input hashes at evaluation time; standard library only.

Use capture_bindings before running your evaluator. Save the returned tags with
the run (e.g. mlflow.set_tags(tags)). This records a producer assertion, not an
attestation that execution actually consumed these files.
"""
import hashlib
import json
from pathlib import Path


def capture_bindings(*, artifact, dataset, evaluator, environment, metrics, output, olive_rank=None):
    output = Path(output).resolve()
    bindings = {
        "schema": "deepbom.review.bindings.v1",
        "producer_statement": "these_files_were_used_for_this_evaluation",
        "metrics": metrics,
    }
    tags = {}
    for name, value in dict(artifact=artifact, dataset=dataset, evaluator=evaluator, environment=environment).items():
        source = Path(value).resolve(strict=True)
        with source.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        bindings[name] = {"path": str(source), "sha256": digest}
        tags[f"deepbom.{name}.sha256"] = digest
    if olive_rank is not None:
        bindings["olive_rank"] = olive_rank
    with output.open("x", encoding="utf-8") as stream:
        json.dump(bindings, stream, indent=2)
        stream.write("\n")
    return tags
