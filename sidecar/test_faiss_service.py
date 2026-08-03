from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

SCRIPT = Path(__file__).with_name("faiss_service.py")
DIMENSION = 1024


def vector(position: int) -> list[float]:
    value = [0.0] * DIMENSION
    value[position] = 1.0
    return value


def run(*args: str) -> object:
    completed = subprocess.run([sys.executable, str(SCRIPT), *args], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def run_failure(*args: str) -> str:
    completed = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)
    assert completed.returncode != 0
    return completed.stderr


def write(path: Path, value: object) -> Path:
    path.write_text(json.dumps(value), "utf-8")
    return path


def test_health_and_empty_status(tmp_path: Path) -> None:
    health = run("health")
    assert health == {"ok": True, "version": health["version"], "dimension": DIMENSION}
    status = run("status", "--db", str(tmp_path / "db"))
    assert status["ok"] is True
    assert status["count"] == 0
    assert status["dimension"] == 0
    assert status["sourceChecksum"] is None


def test_replace_is_atomic_idempotent_and_searchable(tmp_path: Path) -> None:
    db = tmp_path / "db"
    payload = {
        "sourceChecksum": "a" * 64,
        "vectors": [
            {"id": "knowledge:a:0", "vector": vector(0), "metadata": {"contactId": "", "scope": "global"}},
            {"id": "knowledge:b:0", "vector": vector(1), "metadata": {"contactId": "b", "scope": "contact"}},
        ],
    }
    source = write(tmp_path / "replace.json", payload)
    first = run("replace", "--db", str(db), "--input", str(source))
    assert first["unchanged"] is False
    assert first["count"] == 2
    assert first["dimension"] == DIMENSION
    assert first["sourceChecksum"] == "a" * 64
    second = run("replace", "--db", str(db), "--input", str(source))
    assert second["unchanged"] is True
    assert second["contentChecksum"] == first["contentChecksum"]

    query = write(tmp_path / "query.json", {"vector": vector(0), "topK": 2, "threshold": 0.5})
    matches = run("search", "--db", str(db), "--input", str(query))
    assert matches[0]["id"] == "knowledge:a:0"
    assert matches[0]["metadata"]["scope"] == "global"
    assert np.isclose(matches[0]["score"], 1.0)
    assert len(matches) == 1


def test_upsert_delete_and_clear_are_consistent(tmp_path: Path) -> None:
    db = tmp_path / "db"
    upsert_payload = [
        {"id": "one", "vector": vector(0), "metadata": {"source": "one"}},
        {"id": "two", "vector": vector(1), "metadata": {"source": "two"}},
    ]
    upsert = write(tmp_path / "upsert.json", upsert_payload)
    result = run("upsert", "--db", str(db), "--input", str(upsert))
    assert result["count"] == 2
    assert result["total"] == 2
    assert result["dimension"] == DIMENSION

    delete_input = write(tmp_path / "delete.json", {"ids": ["one", "missing"]})
    deleted = run("delete", "--db", str(db), "--input", str(delete_input))
    assert deleted["deleted"] == 1
    assert deleted["count"] == 1
    status = run("status", "--db", str(db))
    assert status["count"] == 1

    cleared = run("clear", "--db", str(db))
    assert cleared == {"cleared": True, "count": 0, "dimension": 0, "sourceChecksum": None}
    assert not (db / "index.faiss").exists()
    assert run("status", "--db", str(db))["count"] == 0


def test_rejects_dimension_zero_nonfinite_duplicate_and_bad_checksum(tmp_path: Path) -> None:
    db = tmp_path / "db"
    invalid_dimension = write(tmp_path / "dimension.json", [{"id": "one", "vector": [1.0, 0.0], "metadata": {}}])
    assert "VECTOR_DIMENSION_MISMATCH" in run_failure("upsert", "--db", str(db), "--input", str(invalid_dimension))

    zero = write(tmp_path / "zero.json", [{"id": "one", "vector": [0.0] * DIMENSION, "metadata": {}}])
    assert "VECTOR_ZERO_NORM" in run_failure("upsert", "--db", str(db), "--input", str(zero))

    duplicate = write(tmp_path / "duplicate.json", {
        "sourceChecksum": "b" * 64,
        "vectors": [
            {"id": "same", "vector": vector(0), "metadata": {}},
            {"id": "same", "vector": vector(1), "metadata": {}},
        ],
    })
    assert "VECTOR_ID_DUPLICATE" in run_failure("replace", "--db", str(db), "--input", str(duplicate))

    bad_checksum = write(tmp_path / "bad-checksum.json", {"sourceChecksum": "short", "vectors": []})
    assert "SOURCE_CHECKSUM_INVALID" in run_failure("replace", "--db", str(db), "--input", str(bad_checksum))


def test_corrupt_partial_store_is_detected_and_full_replace_recovers(tmp_path: Path) -> None:
    db = tmp_path / "db"
    db.mkdir()
    (db / "metadata.json").write_text("{}", "utf-8")
    assert "INDEX_STORE_INCOMPLETE" in run_failure("status", "--db", str(db))

    payload = write(tmp_path / "recover.json", {
        "sourceChecksum": "c" * 64,
        "vectors": [{"id": "recovered", "vector": vector(4), "metadata": {"version": 1}}],
    })
    result = run("replace", "--db", str(db), "--input", str(payload))
    assert result["unchanged"] is False
    assert run("status", "--db", str(db))["count"] == 1


def test_search_rejects_invalid_threshold_and_missing_index(tmp_path: Path) -> None:
    db = tmp_path / "db"
    query = write(tmp_path / "query.json", {"vector": vector(0), "threshold": 1.5})
    # Empty stores are safely empty before threshold evaluation.
    assert run("search", "--db", str(db), "--input", str(query)) == []

    payload = write(tmp_path / "replace.json", {
        "sourceChecksum": "d" * 64,
        "vectors": [{"id": "one", "vector": vector(0), "metadata": {}}],
    })
    run("replace", "--db", str(db), "--input", str(payload))
    assert "SEARCH_THRESHOLD_INVALID" in run_failure("search", "--db", str(db), "--input", str(query))
    (db / "index.faiss").unlink()
    valid_query = write(tmp_path / "valid-query.json", {"vector": vector(0), "threshold": 0.0})
    assert "FAISS_INDEX_MISSING" in run_failure("search", "--db", str(db), "--input", str(valid_query))
