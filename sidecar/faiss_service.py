from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import faiss  # type: ignore
import numpy as np


def emit(value: Any, code: int = 0) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()
    raise SystemExit(code)


def safe_db(path_value: str) -> Path:
    path = Path(path_value).expanduser().resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_store(db: Path) -> tuple[list[str], np.ndarray, dict[str, dict[str, Any]]]:
    vectors_path = db / "vectors.npz"
    metadata_path = db / "metadata.json"
    if not vectors_path.exists() or not metadata_path.exists():
        return [], np.empty((0, 0), dtype="float32"), {}
    with np.load(vectors_path, allow_pickle=False) as payload:
        ids = [str(value) for value in payload["ids"].tolist()]
        vectors = payload["vectors"].astype("float32")
    metadata = json.loads(metadata_path.read_text("utf-8"))
    if not isinstance(metadata, dict):
        raise ValueError("METADATA_INVALID")
    return ids, vectors, metadata


def normalize(vectors: np.ndarray) -> np.ndarray:
    value = np.asarray(vectors, dtype="float32")
    if value.ndim == 1:
        value = value.reshape(1, -1)
    if value.ndim != 2 or value.shape[1] == 0:
        raise ValueError("VECTOR_SHAPE_INVALID")
    faiss.normalize_L2(value)
    return value


def atomic_write(db: Path, ids: list[str], vectors: np.ndarray, metadata: dict[str, dict[str, Any]]) -> None:
    temp_npz, final_npz = db / "vectors.tmp.npz", db / "vectors.npz"
    temp_meta, final_meta = db / "metadata.tmp.json", db / "metadata.json"
    np.savez_compressed(temp_npz, ids=np.asarray(ids, dtype="U128"), vectors=vectors.astype("float32"))
    temp_meta.write_text(json.dumps(metadata, ensure_ascii=False, separators=(",", ":")), "utf-8")
    os.replace(temp_npz, final_npz)
    os.replace(temp_meta, final_meta)
    if vectors.size:
        index = faiss.IndexFlatIP(vectors.shape[1])
        index.add(vectors)
        temp_index, final_index = db / "index.tmp.faiss", db / "index.faiss"
        faiss.write_index(index, str(temp_index))
        os.replace(temp_index, final_index)


def upsert(db: Path, input_path: Path) -> None:
    raw = json.loads(input_path.read_text("utf-8"))
    if not isinstance(raw, list) or not raw or len(raw) > 500:
        raise ValueError("UPSERT_INPUT_INVALID")
    old_ids, old_vectors, metadata = load_store(db)
    table: dict[str, np.ndarray] = {item_id: old_vectors[index] for index, item_id in enumerate(old_ids)} if old_vectors.size else {}
    dimension = old_vectors.shape[1] if old_vectors.size else None
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("vector"), list):
            raise ValueError("UPSERT_ITEM_INVALID")
        item_id = item["id"][:128]
        vector = np.asarray(item["vector"], dtype="float32")
        if vector.ndim != 1 or vector.size == 0 or vector.size > 4096 or not np.isfinite(vector).all():
            raise ValueError("UPSERT_VECTOR_INVALID")
        if dimension is None:
            dimension = int(vector.size)
        if vector.size != dimension:
            raise ValueError("VECTOR_DIMENSION_MISMATCH")
        table[item_id] = normalize(vector)[0]
        item_metadata = item.get("metadata")
        metadata[item_id] = item_metadata if isinstance(item_metadata, dict) else {}
    ids = sorted(table)
    vectors = np.vstack([table[item_id] for item_id in ids]).astype("float32") if ids else np.empty((0, dimension or 0), dtype="float32")
    atomic_write(db, ids, vectors, metadata)
    emit({"count": len(raw), "total": len(ids), "dimension": dimension or 0})


def search(db: Path, input_path: Path) -> None:
    raw = json.loads(input_path.read_text("utf-8"))
    if not isinstance(raw, dict) or not isinstance(raw.get("vector"), list):
        raise ValueError("SEARCH_INPUT_INVALID")
    ids, vectors, metadata = load_store(db)
    if not ids or not vectors.size:
        emit([])
    query = normalize(np.asarray(raw["vector"], dtype="float32"))
    if query.shape[1] != vectors.shape[1]:
        raise ValueError("VECTOR_DIMENSION_MISMATCH")
    top_k = max(1, min(20, int(raw.get("topK", 6))))
    index_path = db / "index.faiss"
    if index_path.exists():
        index = faiss.read_index(str(index_path))
    else:
        index = faiss.IndexFlatIP(vectors.shape[1]); index.add(vectors)
    scores, positions = index.search(query, min(top_k, len(ids)))
    result: list[dict[str, Any]] = []
    for score, position in zip(scores[0].tolist(), positions[0].tolist()):
        if 0 <= position < len(ids):
            item_id = ids[position]
            result.append({"id": item_id, "score": float(score), "metadata": metadata.get(item_id, {})})
    emit(result)


def main() -> None:
    parser = argparse.ArgumentParser(prog="faiss-service")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("health")
    for command in ("upsert", "search"):
        item = sub.add_parser(command); item.add_argument("--db", required=True); item.add_argument("--input", required=True)
    args = parser.parse_args()
    try:
        if args.command == "health": emit({"ok": True, "version": getattr(faiss, "__version__", "unknown")})
        if args.command == "upsert": upsert(safe_db(args.db), Path(args.input).resolve())
        if args.command == "search": search(safe_db(args.db), Path(args.input).resolve())
    except Exception as exc:
        sys.stderr.write(str(exc)[:300]); raise SystemExit(1)


if __name__ == "__main__":
    main()
