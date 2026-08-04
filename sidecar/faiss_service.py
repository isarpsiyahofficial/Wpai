from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import unicodedata
import sys
import time
from pathlib import Path
from typing import Any

import faiss  # type: ignore
import numpy as np

EXPECTED_DIMENSION = 1024
MAX_VECTORS = 10_000
MAX_METADATA_BYTES = 250_000
TEXT_INDEX_VERSION = 1


def configure_utf8_streams() -> None:
    """Keep Turkish metadata lossless across Windows pipes and PyInstaller."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")


configure_utf8_streams()


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


def searchable_text(value: dict[str, Any]) -> str:
    parts = [
        str(value.get("title", "")),
        str(value.get("category", "")),
        str(value.get("content", "")),
    ]
    return " ".join(part.strip() for part in parts if part.strip())


def text_vector(text: str) -> np.ndarray:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    words = re.findall(r"[0-9a-zçğıöşü]+", normalized, flags=re.IGNORECASE)
    if not words:
        raise ValueError("TEXT_QUERY_EMPTY")
    vector = np.zeros(EXPECTED_DIMENSION, dtype="float32")

    def add(feature: str, weight: float) -> None:
        digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
        number = int.from_bytes(digest, "little", signed=False)
        index = number % EXPECTED_DIMENSION
        vector[index] += weight if ((number >> 10) & 1) == 0 else -weight

    for word in words:
        add(f"w:{word}", 2.0)
        if len(word) >= 3:
            padded = f"^{word}$"
            for index in range(len(padded) - 2):
                add(f"g:{padded[index:index + 3]}", 0.5)
    return normalize(vector)[0]


def vector_content_checksum(ids: list[str], vectors: np.ndarray, metadata: dict[str, dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for index, item_id in enumerate(ids):
        digest.update(item_id.encode("utf-8"))
        digest.update(b"\0")
        digest.update(np.asarray(vectors[index], dtype="float32").tobytes(order="C"))
        digest.update(b"\0")
        digest.update(json.dumps(metadata[item_id], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def validate_checksum(value: Any) -> str:
    checksum = str(value or "")
    if len(checksum) != 64 or any(character not in "0123456789abcdefABCDEF" for character in checksum):
        raise ValueError("SOURCE_CHECKSUM_INVALID")
    return checksum.lower()


def validate_metadata(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("VECTOR_METADATA_INVALID")
    if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > MAX_METADATA_BYTES:
        raise ValueError("VECTOR_METADATA_TOO_LARGE")
    return value


def validate_items(value: Any) -> tuple[list[str], np.ndarray, dict[str, dict[str, Any]]]:
    if not isinstance(value, list) or len(value) > MAX_VECTORS:
        raise ValueError("VECTOR_LIST_INVALID")
    ids: list[str] = []
    vectors: list[list[float]] = []
    metadata: dict[str, dict[str, Any]] = {}
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("VECTOR_ITEM_INVALID")
        item_id = str(item.get("id", "")).strip()
        if not item_id or len(item_id) > 256 or item_id in metadata:
            raise ValueError("VECTOR_ID_DUPLICATE" if item_id in metadata else "VECTOR_ID_INVALID")
        vector = item.get("vector")
        if not isinstance(vector, list):
            raise ValueError("VECTOR_VALUE_INVALID")
        ids.append(item_id)
        vectors.append(vector)
        metadata[item_id] = validate_metadata(item.get("metadata", {}))
    if not ids:
        return [], np.empty((0, 0), dtype="float32"), {}
    return ids, normalize(np.asarray(vectors, dtype="float32")), metadata


def write_store(db: Path, ids: list[str], vectors: np.ndarray, metadata: dict[str, dict[str, Any]], source_checksum: str | None) -> dict[str, Any]:
    temporary = db.parent / f"{db.name}.tmp-{os.getpid()}-{time.time_ns()}"
    backup = db.parent / f"{db.name}.bak-{os.getpid()}-{time.time_ns()}"
    temporary.mkdir(parents=True, exist_ok=False)
    try:
        if ids:
            np.savez_compressed(temporary / "vectors.npz", ids=np.asarray(ids), vectors=vectors)
            index = faiss.IndexFlatIP(EXPECTED_DIMENSION)
            index.add(vectors)
            faiss.write_index(index, str(temporary / "index.faiss"))
        (temporary / "metadata.json").write_text(
            json.dumps(metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":")), "utf-8"
        )
        content_checksum = vector_content_checksum(ids, vectors, metadata)
        state = {
            "sourceChecksum": source_checksum,
            "contentChecksum": content_checksum,
            "dimension": EXPECTED_DIMENSION if ids else 0,
            "count": len(ids),
            "updatedAt": int(time.time()),
            "textIndexVersion": TEXT_INDEX_VERSION,
            "textSearchReady": True,
        }
        (temporary / "state.json").write_text(json.dumps(state, separators=(",", ":")), "utf-8")
        if db.exists():
            os.replace(db, backup)
        os.replace(temporary, db)
        shutil.rmtree(backup, ignore_errors=True)
        return state
    except Exception:
        if backup.exists() and not db.exists():
            os.replace(backup, db)
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def command_health(_args: argparse.Namespace) -> None:
    emit({"ok": True, "version": "1.12.0", "dimension": EXPECTED_DIMENSION})


def command_status(args: argparse.Namespace) -> None:
    db = safe_db(args.db)
    ids, vectors, metadata, state = load_store(db)
    if ids:
        content_checksum = vector_content_checksum(ids, vectors, metadata)
        if state.get("contentChecksum") not in (None, content_checksum):
            raise ValueError("INDEX_CONTENT_CHECKSUM_MISMATCH")
    state["ok"] = True
    state["count"] = len(ids)
    state["dimension"] = EXPECTED_DIMENSION if ids else 0
    state.setdefault("textIndexVersion", TEXT_INDEX_VERSION)
    state["textSearchReady"] = True
    emit(state)


def command_replace(args: argparse.Namespace) -> None:
    db = safe_db(args.db)
    payload = read_json(safe_input(args.input))
    if not isinstance(payload, dict):
        raise ValueError("REPLACE_INPUT_INVALID")
    source_checksum = validate_checksum(payload.get("sourceChecksum"))
    ids, vectors, metadata = validate_items(payload.get("vectors"))
    _, _, _, current = load_store(db)
    if current.get("sourceChecksum") == source_checksum and int(current.get("count", -1)) == len(ids):
        current["ok"] = True
        current["unchanged"] = True
        current.setdefault("textIndexVersion", TEXT_INDEX_VERSION)
        current["textSearchReady"] = True
        emit(current)
    state = write_store(db, ids, vectors, metadata, source_checksum)
    emit({"ok": True, "unchanged": False, **state})


def command_upsert(args: argparse.Namespace) -> None:
    db = safe_db(args.db)
    existing_ids, existing_vectors, existing_metadata, state = load_store(db)
    ids, vectors, metadata = validate_items(read_json(safe_input(args.input)))
    position = {item_id: index for index, item_id in enumerate(existing_ids)}
    rows = [existing_vectors[index].copy() for index in range(len(existing_ids))]
    for index, item_id in enumerate(ids):
        if item_id in position:
            rows[position[item_id]] = vectors[index]
        else:
            position[item_id] = len(existing_ids)
            existing_ids.append(item_id)
            rows.append(vectors[index])
        existing_metadata[item_id] = metadata[item_id]
    matrix = normalize(np.asarray(rows, dtype="float32")) if rows else np.empty((0, 0), dtype="float32")
    result = write_store(db, existing_ids, matrix, existing_metadata, state.get("sourceChecksum"))
    emit({"ok": True, "count": len(ids), "total": len(existing_ids), **result})


def command_delete(args: argparse.Namespace) -> None:
    db = safe_db(args.db)
    payload = read_json(safe_input(args.input))
    if not isinstance(payload, dict) or not isinstance(payload.get("ids"), list):
        raise ValueError("DELETE_INPUT_INVALID")
    delete_ids = {str(item).strip() for item in payload["ids"] if str(item).strip()}
    ids, vectors, metadata, state = load_store(db)
    keep = [index for index, item_id in enumerate(ids) if item_id not in delete_ids]
    kept_ids = [ids[index] for index in keep]
    kept_vectors = vectors[keep] if keep else np.empty((0, 0), dtype="float32")
    kept_metadata = {item_id: metadata[item_id] for item_id in kept_ids}
    result = write_store(db, kept_ids, kept_vectors, kept_metadata, state.get("sourceChecksum"))
    emit({"ok": True, "deleted": len(ids) - len(kept_ids), **result})


def command_search(args: argparse.Namespace) -> None:
    db = safe_db(args.db)
    payload = read_json(safe_input(args.input))
    if not isinstance(payload, dict):
        raise ValueError("SEARCH_INPUT_INVALID")
    ids, _vectors, metadata, _state = load_store(db)
    if not ids:
        emit([])
    threshold = float(payload.get("threshold", 0.62))
    if not -1.0 <= threshold <= 1.0:
        raise ValueError("SEARCH_THRESHOLD_INVALID")
    query = normalize(np.asarray(payload.get("vector"), dtype="float32"))[0]
    index_path = db / "index.faiss"
    if not index_path.exists():
        raise ValueError("FAISS_INDEX_MISSING")
    index = faiss.read_index(str(index_path))
    top_k = max(1, min(int(payload.get("topK", 6)), 20, len(ids)))
    scores, positions = index.search(query.reshape(1, -1), top_k)
    matches: list[dict[str, Any]] = []
    for score, position in zip(scores[0].tolist(), positions[0].tolist(), strict=True):
        if position < 0 or score < threshold:
            continue
        item_id = ids[position]
        matches.append({"id": item_id, "score": float(score), "metadata": metadata[item_id]})
    emit(matches)


def command_search_text(args: argparse.Namespace) -> None:
    db = safe_db(args.db)
    payload = read_json(safe_input(args.input))
    if not isinstance(payload, dict):
        raise ValueError("TEXT_SEARCH_INPUT_INVALID")
    query = str(payload.get("query", "")).strip()
    if not query or len(query) > 1000:
        raise ValueError("TEXT_QUERY_INVALID")
    ids, _vectors, metadata, _state = load_store(db)
    if not ids:
        emit([])
    threshold = float(payload.get("threshold", 0.08))
    if not -1.0 <= threshold <= 1.0:
        raise ValueError("SEARCH_THRESHOLD_INVALID")
    top_k = max(1, min(int(payload.get("topK", 8)), 20, len(ids)))
    query_vector = text_vector(query)
    document_vectors = normalize(np.asarray([text_vector(searchable_text(metadata[item_id])) for item_id in ids], dtype="float32"))
    scores = document_vectors @ query_vector
    order = np.argsort(-scores)
    matches = [
        {"id": ids[int(index)], "score": float(scores[int(index)]), "metadata": metadata[ids[int(index)]]}
        for index in order[:top_k]
        if float(scores[int(index)]) >= threshold
    ]
    emit(matches)


def command_clear(args: argparse.Namespace) -> None:
    db = safe_db(args.db)
    if db.exists():
        shutil.rmtree(db)
    db.mkdir(parents=True, exist_ok=True)
    emit({"cleared": True, "count": 0, "dimension": 0, "sourceChecksum": None})


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(prog="faiss-service")
    commands = value.add_subparsers(dest="command", required=True)
    commands.add_parser("health")
    for name in ("status", "clear"):
        command = commands.add_parser(name)
        command.add_argument("--db", required=(name != "health"))
    for name in ("replace", "upsert", "delete", "search", "search-text"):
        command = commands.add_parser(name)
        command.add_argument("--db", required=True)
        command.add_argument("--input", required=True)
    return value


def main() -> None:
    args = parser().parse_args()
    try:
        {
            "health": command_health,
            "status": command_status,
            "replace": command_replace,
            "upsert": command_upsert,
            "delete": command_delete,
            "search": command_search,
            "search-text": command_search_text,
            "clear": command_clear,
        }[args.command](args)
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - safe error code only
        sys.stderr.write(str(error)[:300])
        sys.stderr.flush()
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
