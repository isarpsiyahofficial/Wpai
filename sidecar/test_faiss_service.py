from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

SCRIPT = Path(__file__).with_name("faiss_service.py")


def run(*args: str) -> object:
    completed = subprocess.run([sys.executable, str(SCRIPT), *args], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def test_health() -> None:
    result = run("health")
    assert isinstance(result, dict)
    assert result["ok"] is True


def test_upsert_and_search_are_isolated_and_deterministic(tmp_path: Path) -> None:
    payload = [
        {"id": "customer-a", "vector": [1.0, 0.0, 0.0], "metadata": {"contactId": "a"}},
        {"id": "customer-b", "vector": [0.0, 1.0, 0.0], "metadata": {"contactId": "b"}},
    ]
    upsert_file = tmp_path / "upsert.json"
    upsert_file.write_text(json.dumps(payload), "utf-8")
    result = run("upsert", "--db", str(tmp_path / "db"), "--input", str(upsert_file))
    assert result == {"count": 2, "total": 2, "dimension": 3}

    query_file = tmp_path / "query.json"
    query_file.write_text(json.dumps({"vector": [1.0, 0.0, 0.0], "topK": 2}), "utf-8")
    matches = run("search", "--db", str(tmp_path / "db"), "--input", str(query_file))
    assert matches[0]["id"] == "customer-a"
    assert matches[0]["metadata"]["contactId"] == "a"
    assert np.isclose(matches[0]["score"], 1.0)


def test_rejects_dimension_mismatch(tmp_path: Path) -> None:
    first = tmp_path / "first.json"
    first.write_text(json.dumps([{"id": "one", "vector": [1.0, 0.0], "metadata": {}}]), "utf-8")
    run("upsert", "--db", str(tmp_path / "db"), "--input", str(first))
    invalid = tmp_path / "invalid.json"
    invalid.write_text(json.dumps([{"id": "two", "vector": [1.0, 0.0, 0.0], "metadata": {}}]), "utf-8")
    completed = subprocess.run([sys.executable, str(SCRIPT), "upsert", "--db", str(tmp_path / "db"), "--input", str(invalid)], capture_output=True, text=True)
    assert completed.returncode != 0
    assert "VECTOR_DIMENSION_MISMATCH" in completed.stderr
