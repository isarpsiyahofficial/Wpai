from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read_jsonc(path: Path) -> dict:
    text = path.read_text("utf-8")
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"(^|\s)//.*", r"\1", text)
    return json.loads(text)


def assert_file(path: str) -> None:
    if not (ROOT / path).is_file():
        raise AssertionError(f"Required file missing: {path}")


def validate_files() -> None:
    required = [
        "package.json", "wrangler.jsonc", "index.html", "src/worker/index.ts", "src/frontend/main.tsx",
        "src/frontend/pages/whatsapp.tsx", "src/frontend/pages/settings.tsx", "src/frontend/pages/knowledgeAi.tsx",
        "src-tauri/tauri.conf.json", "src-tauri/src/lib.rs", "sidecar/faiss_service.py",
        "migrations/0001_initial.sql", "migrations/0002_indexes.sql", "migrations/0003_default_settings.sql",
        "tests/worker/auth.test.ts", "tests/worker/isolation-and-gates.test.ts", "tests/worker/webhook.test.ts"
    ]
    for item in required:
        assert_file(item)
    forbidden = [ROOT / ".bootstrap", ROOT / ".source-bootstrap"]
    for path in forbidden:
        if path.exists():
            raise AssertionError(f"Temporary bootstrap artifact must be removed: {path.name}")


def validate_wrangler() -> None:
    config = read_jsonc(ROOT / "wrangler.jsonc")
    assert config["name"] == "wa-ai-panel"
    database = config["d1_databases"][0]
    assert database["database_name"] == "wa-ai-prod"
    assert database["database_id"] == "81983219-f57b-487b-8144-7c70bf9b1fe2"
    assert config["r2_buckets"][0]["bucket_name"] == "wa-ai-files-prod"
    expected_queues = {"wa-inbound-ai", "wa-outbound", "wa-admin-notify", "wa-ai-dlq", "wa-outbound-dlq"}
    producers = {item["queue"] for item in config["queues"]["producers"]}
    assert producers == expected_queues
    assert config["vars"]["DEFAULT_AI_MODEL"] == "@cf/meta/llama-3.1-8b-instruct-fast"
    assert config["vars"]["DEFAULT_EMBEDDING_MODEL"] == "@cf/baai/bge-m3"
    serialized = json.dumps(config)
    for forbidden in ("META_ACCESS_TOKEN", "META_APP_SECRET", "ADMIN_BOOTSTRAP_TOKEN", "SESSION_SIGNING_KEY", "DATA_ENCRYPTION_KEY"):
        if forbidden in serialized:
            raise AssertionError(f"Secret key must not be declared in wrangler vars: {forbidden}")


def validate_migrations() -> None:
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys=ON")
    migrations = sorted((ROOT / "migrations").glob("[0-9][0-9][0-9][0-9]_*.sql"))
    if not migrations:
        raise AssertionError("No migrations found")
    for migration in migrations:
        connection.executescript(migration.read_text("utf-8"))
    foreign_key_errors = connection.execute("PRAGMA foreign_key_check").fetchall()
    if foreign_key_errors:
        raise AssertionError(f"Foreign key errors: {foreign_key_errors}")
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    required_tables = {
        "system_settings", "admins", "admin_sessions", "contacts", "conversations", "messages", "attachments",
        "business_knowledge", "knowledge_chunks", "service_catalog", "pricing_rules", "ai_jobs", "ai_decisions",
        "human_handoffs", "admin_notifications", "follow_up_tasks", "audit_logs", "webhook_events",
        "integration_credentials", "admin_ai_threads", "admin_ai_messages"
    }
    missing = required_tables - tables
    if missing:
        raise AssertionError(f"Required D1 tables missing: {sorted(missing)}")
    defaults = dict(connection.execute("SELECT key,value_json FROM system_settings WHERE key IN ('ai_global_mode','ai_auto_reply_enabled','ai_suggestion_mode','admin_notifications_enabled')"))
    assert json.loads(defaults["ai_global_mode"]) == "off"
    assert json.loads(defaults["ai_auto_reply_enabled"]) is False
    assert json.loads(defaults["ai_suggestion_mode"]) is True
    assert json.loads(defaults["admin_notifications_enabled"]) is False
    duplicate_indexes = connection.execute("SELECT name,COUNT(*) FROM sqlite_master WHERE type='index' AND name IS NOT NULL GROUP BY name HAVING COUNT(*)>1").fetchall()
    assert not duplicate_indexes
    connection.close()


def validate_product_scope() -> None:
    app = (ROOT / "src/frontend/App.tsx").read_text("utf-8")
    if "campaign" in app.lower() or "kampanya" in app.lower():
        raise AssertionError("Campaign navigation must not be present")
    api = (ROOT / "src/worker/api.ts").read_text("utf-8") + (ROOT / "src/worker/extendedApi.ts").read_text("utf-8")
    if re.search(r"(?:post|put)\('/campaign", api, re.I):
        raise AssertionError("Campaign execution API must remain disabled")
    settings = (ROOT / "src/frontend/pages/settings.tsx").read_text("utf-8")
    for label in ("Tam Sistem Taraması", "Eksikleri Kur ve Onar", "WhatsApp Business API", "Parola Değiştir"):
        if label not in settings:
            raise AssertionError(f"Settings capability missing: {label}")


if __name__ == "__main__":
    validate_files()
    validate_wrangler()
    validate_migrations()
    validate_product_scope()
    print("Static validation passed: files, Cloudflare manifest, D1 schema, safe defaults and product scope are consistent.")
