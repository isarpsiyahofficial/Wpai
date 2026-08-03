from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path
from typing import Any

import faiss  # type: ignore
import numpy as np

EXPECTED_DIMENSION = 1024
MAX_VECTORS = 10_000
MAX_METADATA_BYTES = 250_000


def emit(value: Any, code: int = 0) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()
    raise SystemExit(code)


def safe_db(path_value: str) -> Path:
    path = Path(path_value).expanduser().resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def safe_input(path_value: str) -> Path:
    path = Path(path_value).expanduser().resolve()
    if not path.is_file() or path.stat().st_size > 250 * 1024 * 1024:
        raise ValueError("INPUT_FILE_INVALID")
    return path


def read_json(path: Path) -> Any:
    return json.loads(path.read_text("utf-8"))


def load_state(db: Path) -> dict[str, Any]:
    state_path = db / "state.json"
    if not state_path.exists():
        return {"sourceChecksum": None, "dimension": 0, "count": 0, "updatedAt": None}
    state = read_json(state_path)
    if not isinstance(state, dict):
        raise ValueError("STATE_INVALID")
    return state


def load_store(db: Path) -> tuple[list[str], np.ndarray, dict[str, dict[str, Any]], dict[str, Any]]:
    vectors_path = db / "vectors.npz"
    metadata_path = db / "metadata.json"
    state = load_state(db)
    if not vectors_path.exists() and not metadata_path.exists():
        return [], np.empty((0, 0), dtype="float32"), {}, state
    if not vectors_path.exists() or not metadata_path.exists():
        raise ValueError("INDEX_STORE_INCOMPLETE")
    with np.load(vectors_path, allow_pickle=False) as payload:
        if "ids" not in payload or "vectors" not in payload:
            raise ValueError("VECTOR_STORE_INVALID")
        ids = [str(value) for value in payload["ids"].tolist()]
        vectors = payload["vectors"].astype("float32")
    metadata = read_json(metadata_path)
    if not isinstance(metadata, dict):
        raise ValueError("METADATA_INVALID")
    if vectors.ndim != 2 or vectors.shape[0] != len(ids):
        raise ValueError("VECTOR_STORE_SHAPE_INVALID")
    if len(ids) != len(set(ids)) or set(metadata) != set(ids):
        raise ValueError("INDEX_STORE_ID_MISMATCH")
    if vectors.size and (vectors.shape[1] != EXPECTED_DIMENSION or not np.isfinite(vectors).all()):
        raise ValueError("INDEX_STORE_VECTOR_INVALID")
    if int(state.get("count", len(ids))) != len(ids):
        raise ValueError("INDEX_STATE_COUNT_MISMATCH")
    return ids, vectors, metadata, state


def normalize(vectors: np.ndarray) -> np.ndarray:
    value = np.asarray(vectors, dtype="float32")
    if value.ndim == 1:
        value = value.reshape(1, -1)
    if value.ndim != 2 or value.shape[1] != EXPECTED_DIMENSION:
        raise ValueError("VECTOR_DIMENSION_MISMATCH")
    if not np.isfinite(value).all():
        raise ValueError("VECTOR_NON_FINITE")
    norms = np.linalg.norm(value, axis=1)
    if np.any(norms <= 0):
        raise ValueError("VECTOR_ZERO_NORM")
    faiss.normalize_L2(value)
    return value


def checksum_payload(ids: list[str], vectors: np.ndarray, metadata: dict[str, dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for index, item_id in enumerate(ids):
        digest.update(item_id.encode("utf-8"))
        digest.update(vectors[index].astype("float32").tobytes())
        digest.update(json.dumps(metadata[item_id], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    return digest.hexdigest()


def atomic_write(
    db: Path,
    ids: list[str],
    vectors: np.ndarray,
    metadata: dict[str, dict[str, Any]],
    source_checksum: str | None,
) -> dict[str, Any]:
    temp_dir = db / f".sync-{os.getpid()}-{time.time_ns()}"
    temp_dir.mkdir(parents=True, exist_ok=False)
    try:
        np.savez_compressed(temp_dir / "vectors.npz", ids=np.asarray(ids, dtype="U256"), vectors=vectors.astype("float32"))
        (temp_dir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, separators=(",", ":")), "utf-8")
        if ids:
            index = faiss.IndexFlatIP(EXPECTED_DIMENSION)
            index.add(vectors)
            faiss.write_index(index, str(temp_dir / "index.faiss"))
        content_checksum = checksum_payload(ids, vectors, metadata) if ids else hashlib.sha256(b"").hexdigest()
        state = {
            "sourceChecksum": source_checksum,
            "contentChecksum": content_checksum,
            "dimension": EXPECTED_DIMENSION if ids else 0,
            "count": len(ids),
            "updatedAt": int(time.time()),
        }
        (temp_dir / "state.json").write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":")), "utf-8")
        for name in ("vectors.npz", "metadata.json", "state.json", "index.faiss"):
            source = temp_dir / name
            destination = db / name
            if source.exists():
                os.replace(source, destination)
            elif destination.exists():
                destination.unlink()
        return state
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def validate_item(item: Any) -> tuple[str, np.ndarray, dict[str, Any]]:
    if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("vector"), list):
        raise ValueError("VECTOR_ITEM_INVALID")
    item_id = item["id"].strip()
    if not item_id or len(item_id) > 256:
        raise ValueError("VECTOR_ID_INVALID")
    vector = normalize(np.asarray(item["vector"], dtype="float32"))[0]
    metadata_value = item.get("metadata")
    metadata = metadata_value if isinstance(metadata_value, dict) else {}
    if len(json.dumps(metadata, ensure_ascii=False).encode("utf-8")) > MAX_METADATA_BYTES:
        raise ValueError("VECTOR_METADATA_TOO_LARGE")
    return item_id, vector, metadata


def replace(db: Path, input_path: Path) -> None:
    raw = read_json(input_path)
    if not isinstance(raw, dict) or not isinstance(raw.get("vectors"), list):
        raise ValueError("REPLACE_INPUT_INVALID")
    source_checksum = raw.get("sourceChecksum")
    if not isinstance(source_checksum, str) or len(source_checksum) != 64:
        raise ValueError("SOURCE_CHECKSUM_INVALID")
    items = raw["vectors"]
    if len(items) > MAX_VECTORS:
        raise ValueError("VECTOR_LIMIT_EXCEEDED")
    try:
        _, _, _, current = load_store(db)
        if current.get("sourceChecksum") == source_checksum:
            emit({"unchanged": True, **current})
    except ValueError:
        # A corrupt local cache is recoverable only through a complete verified replacement.
        pass
    table: dict[str, np.ndarray] = {}
    metadata: dict[str, dict[str, Any]] = {}
    for item in items:
        item_id, vector, item_metadata = validate_item(item)
        if item_id in table:
            raise ValueError("VECTOR_ID_DUPLICATE")
        table[item_id] = vector
        metadata[item_id] = item_metadata
    ids = sorted(table)
    vectors = np.vstack([table[item_id] for item_id in ids]).astype("float32") if ids else np.empty((0, EXPECTED_DIMENSION), dtype="float32")
    state = atomic_write(db, ids, vectors, metadata, source_checksum)
    emit({"unchanged": False, **state})


def upsert(db: Path, input_path: Path) -> None:
    raw = read_json(input_path)
    if not isinstance(raw, list) or not raw or len(raw) > 500:
        raise ValueError("UPSERT_INPUT_INVALID")
    ids, vectors, metadata, _ = load_store(db)
    table: dict[str, np.ndarray] = {item_id: vectors[index] for index, item_id in enumerate(ids)} if vectors.size else {}
    for item in raw:
        item_id, vector, item_metadata = validate_item(item)
        table[item_id] = vector
        metadata[item_id] = item_metadata
    next_ids = sorted(table)
    next_vectors = np.vstack([table[item_id] for item_id in next_ids]).astype("float32")
    state = atomic_write(db, next_ids, next_vectors, metadata, None)
    emit({"count": len(raw), "total": len(next_ids), "dimension": EXPECTED_DIMENSION, "contentChecksum": state["contentChecksum"]})


def delete(db: Path, input_path: Path) -> None:
    raw = read_json(input_path)
    ids_to_delete = raw.get("ids") if isinstance(raw, dict) else None
    if not isinstance(ids_to_delete, list) or not ids_to_delete or len(ids_to_delete) > 1000:
        raise ValueError("DELETE_INPUT_INVALID")
    requested = {str(value) for value in ids_to_delete if isinstance(value, str) and value}
    ids, vectors, metadata, _ = load_store(db)
    keep = [index for index, item_id in enumerate(ids) if item_id not in requested]
    next_ids = [ids[index] for index in keep]
    next_vectors = vectors[keep] if keep else np.empty((0, EXPECTED_DIMENSION), dtype="float32")
    next_metadata = {item_id: metadata[item_id] for item_id in next_ids}
    state = atomic_write(db, next_ids, next_vectors, next_metadata, None)
    emit({"deleted": len(ids) - len(next_ids), **state})


def clear(db: Path) -> None:
    for name in ("vectors.npz", "metadata.json", "state.json", "index.faiss"):
        path = db / name
        if path.exists():
            path.unlink()
    emit({"cleared": True, "count": 0, "dimension": 0, "sourceChecksum": None})


def status(db: Path) -> None:
    ids, vectors, _, state = load_store(db)
    emit({
        "ok": True,
        "count": len(ids),
        "dimension": int(vectors.shape[1]) if vectors.size else 0,
        "sourceChecksum": state.get("sourceChecksum"),
        "contentChecksum": state.get("contentChecksum"),
        "updatedAt": state.get("updatedAt"),
    })


def search(db: Path, input_path: Path) -> None:
    raw = read_json(input_path)
    if not isinstance(raw, dict) or not isinstance(raw.get("vector"), list):
        raise ValueError("SEARCH_INPUT_INVALID")
    ids, vectors, metadata, _ = load_store(db)
    if not ids or not vectors.size:
        emit([])
    query = normalize(np.asarray(raw["vector"], dtype="float32"))
    top_k = max(1, min(20, int(raw.get("topK", 6))))
    threshold = float(raw.get("threshold", -1.0))
    if not np.isfinite(threshold) or threshold < -1.0 or threshold > 1.0:
        raise ValueError("SEARCH_THRESHOLD_INVALID")
    index_path = db / "index.faiss"
    if not index_path.exists():
        raise ValueError("FAISS_INDEX_MISSING")
    index = faiss.read_index(str(index_path))
    if index.d != EXPECTED_DIMENSION or index.ntotal != len(ids):
        raise ValueError("FAISS_INDEX_STATE_MISMATCH")
    scores, positions = index.search(query, min(top_k, len(ids)))
    result: list[dict[str, Any]] = []
    for score, position in zip(scores[0].tolist(), positions[0].tolist()):
        if 0 <= position < len(ids) and score >= threshold:
            item_id = ids[position]
            result.append({"id": item_id, "score": float(score), "metadata": metadata[item_id]})
    emit(result)


def main() -> None:
    parser = argparse.ArgumentParser(prog="faiss-service")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("health")
    for command in ("status", "clear"):
        item = sub.add_parser(command)
        item.add_argument("--db", required=True)
    for command in ("replace", "upsert", "delete", "search"):
        item = sub.add_parser(command)
        item.add_argument("--db", required=True)
        item.add_argument("--input", required=True)
    args = parser.parse_args()
    try:
        if args.command == "health": emit({"ok": True, "version": getattr(faiss, "__version__", "unknown"), "dimension": EXPECTED_DIMENSION})
        db = safe_db(args.db)
        if args.command == "status": status(db)
        if args.command == "clear": clear(db)
        input_path = safe_input(args.input)
        if args.command == "replace": replace(db, input_path)
        if args.command == "upsert": upsert(db, input_path)
        if args.command == "delete": delete(db, input_path)
        if args.command == "search": search(db, input_path)
    except Exception as exc:
        sys.stderr.write(str(exc)[:500])
        raise SystemExit(1)


if __name__ == "__main__":
    main()
