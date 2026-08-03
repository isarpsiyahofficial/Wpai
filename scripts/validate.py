from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read_jsonc(path: Path) -> dict:
    return json.loads(path.read_text("utf-8"))


def assert_file(path: str) -> None:
    if not (ROOT / path).is_file():
        raise AssertionError(f"Required file missing: {path}")


def validate_files() -> None:
    required = [
        "package.json", "package-lock.json", "wrangler.jsonc", "index.html", "rust-toolchain.toml",
        ".github/workflows/ci.yml", ".github/workflows/windows-desktop.yml",
        ".github/workflows/deploy-production.yml", ".github/workflows/e2e-live-scenarios.yml",
        "src/worker/index.ts", "src/worker/usageApi.ts", "src/worker/vectorSync.ts",
        "src/worker/trainingApi.ts", "src/worker/deadLetter.ts", "src/frontend/main.tsx",
        "src/frontend/styles.css", "src/frontend/neuron.css", "src/frontend/responsive.css",
        "src/frontend/pages/whatsapp.tsx", "src/frontend/pages/settings.tsx",
        "src/frontend/pages/knowledgeAi.tsx", "src/frontend/pages/aiPage.tsx",
        "src/frontend/pages/dashboardReports.tsx", "src/frontend/pages/index.ts",
        "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json", "src-tauri/src/lib.rs",
        "sidecar/faiss_service.py", "sidecar/requirements.txt", "sidecar/test_faiss_service.py",
        "migrations/0001_initial.sql", "migrations/0002_indexes.sql", "migrations/0003_default_settings.sql",
        "migrations/0004_feature_modules.sql", "migrations/0005_runtime_hardening.sql",
        "migrations/0006_ai_usage_and_summary_settings.sql", "migrations/0007_training_vector_desktop.sql",
        "migrations/0008_training_publication_links.sql", "migrations/0009_source_extractions.sql",
        "tests/worker/auth.test.ts", "tests/worker/isolation-and-gates.test.ts", "tests/worker/webhook.test.ts",
        "tests/worker/scoped-files.test.ts", "tests/worker/neuron-usage.test.ts", "tests/unit/ai-claims.test.ts",
        "tests/e2e/playwright.config.mjs", "tests/e2e/responsive.spec.mjs", "tests/e2e/live-worker-smoke.mjs"
    ]
    for item in required:
        assert_file(item)
    forbidden = [
        ROOT / ".bootstrap", ROOT / ".source-bootstrap", ROOT / ".completion-patch-trigger",
        ROOT / ".ai-state-trigger", ROOT / ".package-lock-trigger", ROOT / ".cargo-lock-trigger",
        ROOT / ".github/workflows/apply-completion-patch.yml",
        ROOT / ".github/workflows/one-shot-ai-state.yml",
        ROOT / ".github/workflows/generate-package-lock.yml",
        ROOT / ".github/workflows/generate-cargo-lock.yml"
    ]
    for path in forbidden:
        if path.exists():
            raise AssertionError(f"Temporary bootstrap or one-shot artifact must be removed: {path.name}")


def validate_package_lock() -> None:
    package = json.loads((ROOT / "package.json").read_text("utf-8"))
    lock = json.loads((ROOT / "package-lock.json").read_text("utf-8"))
    if lock.get("lockfileVersion") != 3:
        raise AssertionError("package-lock.json must use npm lockfileVersion 3")
    root = lock.get("packages", {}).get("")
    if not isinstance(root, dict):
        raise AssertionError("package-lock.json root package is missing")
    for key in ("name", "version", "dependencies", "devDependencies"):
        if root.get(key) != package.get(key):
            raise AssertionError(f"package-lock.json is out of sync with package.json: {key}")
    workflows = "\n".join((ROOT / path).read_text("utf-8") for path in (
        ".github/workflows/ci.yml", ".github/workflows/windows-desktop.yml",
        ".github/workflows/deploy-production.yml", ".github/workflows/e2e-live-scenarios.yml"
    ))
    if "npm install --no-audit --no-fund" in workflows or "npm install --ignore-scripts" in workflows:
        raise AssertionError("Primary CI and deployment installs must use npm ci")
    if workflows.count("npm ci") < 7:
        raise AssertionError("Locked npm installs are missing from one or more workflows")


def validate_cargo_lock() -> None:
    cargo_lock = (ROOT / "src-tauri/Cargo.lock").read_text("utf-8")
    if not re.search(r"(?m)^version = 3$", cargo_lock):
        raise AssertionError("src-tauri/Cargo.lock must use lockfile version 3")
    for package in ("wpai-desktop", "tauri", "tauri-build", "keyring"):
        if f'name = "{package}"' not in cargo_lock:
            raise AssertionError(f"Cargo.lock package missing: {package}")
    toolchain = (ROOT / "rust-toolchain.toml").read_text("utf-8")
    if 'channel = "1.97.1"' not in toolchain or 'targets = ["x86_64-pc-windows-msvc"]' not in toolchain:
        raise AssertionError("Rust toolchain and Windows target must be pinned")
    windows_workflow = (ROOT / ".github/workflows/windows-desktop.yml").read_text("utf-8")
    for command in (
        "cargo test --locked --manifest-path src-tauri/Cargo.toml",
        "cargo clippy --locked --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings",
        "cargo check --locked --manifest-path src-tauri/Cargo.toml",
        "npm run desktop:build", "src-tauri/target/release/bundle/nsis"
    ):
        if command not in windows_workflow:
            raise AssertionError(f"Windows deterministic test/build command missing: {command}")


def validate_e2e_gates() -> None:
    workflow = (ROOT / ".github/workflows/e2e-live-scenarios.yml").read_text("utf-8")
    for required in (
        "Responsive browser, overlap and workflow checks",
        "Local Wrangler production-like HTTP, D1, R2 and webhook flow",
        "Alternative Node 24 full code path", "@playwright/test@1.55.0",
        "npx playwright test --config=tests/e2e/playwright.config.mjs",
        "wrangler d1 migrations apply wa-ai-prod --local",
        "node tests/e2e/live-worker-smoke.mjs", "node-version: 24"
    ):
        if required not in workflow:
            raise AssertionError(f"Live-like or responsive CI gate missing: {required}")
    browser = (ROOT / "tests/e2e/responsive.spec.mjs").read_text("utf-8")
    for required in (
        "phone-320x568", "phone-390x844", "tablet-768x1024",
        "laptop-1366x768", "desktop-1920x1080",
        "document horizontal overflow", "clipped text", "overlapping sibling elements",
        "critical administrator workflows", "setup and login screens", "API failure"
    ):
        if required not in browser:
            raise AssertionError(f"Responsive browser coverage missing: {required}")
    smoke = (ROOT / "tests/e2e/live-worker-smoke.mjs").read_text("utf-8")
    for required in (
        "health-and-security-headers", "auth-and-csrf", "contacts-and-csv",
        "meta-verification-and-signed-webhook", "webhook-idempotency",
        "manual-message-idempotency", "r2-scoped-file-roundtrip",
        "neuron-safety-limit", "reports-and-export", "api-not-found"
    ):
        if required not in smoke:
            raise AssertionError(f"Live Wrangler smoke coverage missing: {required}")
    main = (ROOT / "src/frontend/main.tsx").read_text("utf-8")
    imports = [main.find("./styles.css"), main.find("./neuron.css"), main.find("./responsive.css")]
    if min(imports) < 0 or imports != sorted(imports):
        raise AssertionError("Responsive hardening must load after base and Neuron styles")


def validate_wrangler() -> None:
    config = read_jsonc(ROOT / "wrangler.jsonc")
    assert config["name"] == "wa-ai-panel"
    database = config["d1_databases"][0]
    assert database["database_name"] == "wa-ai-prod"
    assert database["database_id"] == "81983219-f57b-487b-8144-7c70bf9b1fe2"
    assert config["r2_buckets"][0]["bucket_name"] == "wa-ai-files-prod"
    assert config["vectorize"][0]["index_name"] == "wa-ai-knowledge-prod"
    expected_queues = {
        "wa-inbound-ai", "wa-outbound", "wa-admin-notify", "wa-ai-dlq",
        "wa-outbound-dlq", "wa-knowledge-index"
    }
    producers = {item["queue"] for item in config["queues"]["producers"]}
    assert producers == expected_queues
    consumers = {item["queue"] for item in config["queues"]["consumers"]}
    assert "wa-knowledge-index" in consumers
    assert config["vars"]["DEFAULT_AI_MODEL"] == "@cf/meta/llama-3.1-8b-instruct-fp8-fast"
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
        "integration_credentials", "admin_ai_threads", "admin_ai_messages", "ai_usage_records",
        "ai_training_items", "ai_training_thread_state", "knowledge_sources", "knowledge_source_extractions",
        "knowledge_versions", "vector_sync_jobs", "retrieval_logs", "desktop_devices", "desktop_sessions",
        "csv_imports", "csv_import_rows", "canned_replies", "dead_letter_jobs",
        "training_item_publications", "source_knowledge_links"
    }
    missing = required_tables - tables
    if missing:
        raise AssertionError(f"Required D1 tables missing: {sorted(missing)}")
    defaults = dict(connection.execute(
        "SELECT key,value_json FROM system_settings WHERE key IN "
        "('ai_global_mode','ai_auto_reply_enabled','ai_suggestion_mode','admin_notifications_enabled',"
        "'ai_daily_neuron_limit','ai_summary_message_interval','ai_similarity_threshold','desktop_autostart_enabled')"
    ))
    assert json.loads(defaults["ai_global_mode"]) == "off"
    assert json.loads(defaults["ai_auto_reply_enabled"]) is False
    assert json.loads(defaults["ai_suggestion_mode"]) is True
    assert json.loads(defaults["admin_notifications_enabled"]) is False
    assert json.loads(defaults["ai_daily_neuron_limit"]) == 10000
    assert json.loads(defaults["ai_summary_message_interval"]) == 8
    assert 0 <= json.loads(defaults["ai_similarity_threshold"]) < 1
    assert json.loads(defaults["desktop_autostart_enabled"]) is False
    webhook_indexes = {row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='webhook_events'")}
    assert "ux_webhook_events_payload_hash" in webhook_indexes
    duplicate_indexes = connection.execute(
        "SELECT name,COUNT(*) FROM sqlite_master WHERE type='index' AND name IS NOT NULL GROUP BY name HAVING COUNT(*)>1").fetchall()
    assert not duplicate_indexes
    connection.close()


def validate_product_scope() -> None:
    app = (ROOT / "src/frontend/App.tsx").read_text("utf-8")
    if "campaign" in app.lower() or "kampanya" in app.lower():
        raise AssertionError("Campaign navigation must not be present")
    api = "\n".join((ROOT / path).read_text("utf-8") for path in (
        "src/worker/api.ts", "src/worker/extendedApi.ts", "src/worker/trainingApi.ts"
    ))
    if re.search(r"(?:post|put)\('/campaign", api, re.I):
        raise AssertionError("Campaign execution API must remain disabled")
    infrastructure = (ROOT / "src/worker/infrastructure.ts").read_text("utf-8")
    for required in ("wa-ai-knowledge-prod", "wa-knowledge-index", "Yalnız wa-ai-knowledge-prod"):
        if required not in infrastructure:
            raise AssertionError(f"Infrastructure safety capability missing: {required}")
    training = (ROOT / "src/worker/trainingApi.ts").read_text("utf-8")
    for required in (
        "/training/sessions", "/training/items", "/training/sources", "/training/simulate",
        "/training/export", "/training/import", "/training/memory/clear", "/training/index-status",
        "toMarkdown", "verifyPassword", "enqueueKnowledgeSync"
    ):
        if required not in training:
            raise AssertionError(f"Training center capability missing: {required}")
    ai = (ROOT / "src/worker/ai.ts").read_text("utf-8")
    for required in ("ai_similarity_threshold", "retrieval_logs", "matchBelongsToScope", "return [];"):
        if required not in ai:
            raise AssertionError(f"Scoped retrieval capability missing: {required}")
    settings = (ROOT / "src/frontend/pages/settings.tsx").read_text("utf-8")
    for label in ("Tam Sistem Taraması", "Eksikleri Kur ve Onar", "WhatsApp Business API", "Parola Değiştir"):
        if label not in settings:
            raise AssertionError(f"Settings capability missing: {label}")
    pages_index = (ROOT / "src/frontend/pages/index.ts").read_text("utf-8")
    if "export { DashboardPage, ReportsPage } from './dashboardReports';" not in pages_index:
        raise AssertionError("Dashboard and reports must use the transparent Neuron views")
    whatsapp = (ROOT / "src/frontend/pages/whatsapp.tsx").read_text("utf-8")
    if "`/api/attachments/${" in whatsapp or 'href={`/api/attachments/' in whatsapp:
        raise AssertionError("Chat attachments must never use the unscoped legacy route")
    if "/api/conversations/${detail.conversation.id}/attachments/${String(message.attachment_id)}" not in whatsapp:
        raise AssertionError("Chat attachments must use the conversation-scoped route")
    ai_page = (ROOT / "src/frontend/pages/aiPage.tsx").read_text("utf-8")
    for label in (
        "Bugün kullanılan", "Resmî günlük tahsis", "Resmî tahsise kalan",
        "Yapılandırılmış günlük güvenlik limiti", "Güvenlik limitine kalan",
        "Girdi / çıktı tokenı", "Son güncelleme", "Veri kaynağı: Hesaplanan tahmin",
        "Uyarı eşiği", "Kritik eşik", "Durdurma eşiği", "Kota dolunca güvenli mod",
        "Modele göre bugünkü kullanım", "İşlem türüne göre bugünkü kullanım", "30 Günlük Neuron Geçmişi"
    ):
        if label not in ai_page:
            raise AssertionError(f"Neuron usage field missing from active AI page: {label}")
    dashboard_reports = (ROOT / "src/frontend/pages/dashboardReports.tsx").read_text("utf-8")
    for label in (
        "Bugün kullanılan tahmini Neuron", "Resmî günlük tahsis",
        "Resmî tahsise kalan (uygulama tahmini)", "Yönetici güvenlik limiti",
        "Güvenlik limitine kalan", "Güvenlik limiti kullanımı", "Sağlayıcı raporu"
    ):
        if label not in dashboard_reports:
            raise AssertionError(f"Neuron distinction missing from dashboard or reports: {label}")
    usage_api = (ROOT / "src/worker/usageApi.ts").read_text("utf-8")
    for field in (
        "estimatedUsedNeurons", "providerReportedUsedNeurons", "officialDailyAllocationNeurons",
        "configuredSafetyLimitNeurons", "safetyLimitRemainingNeurons", "byModel", "byOperation",
        "dailyHistory", "lastUpdatedAt", "providerUsageAvailable", "configuredFallbackMode"
    ):
        if field not in usage_api:
            raise AssertionError(f"Neuron API field missing: {field}")


if __name__ == "__main__":
    validate_files()
    validate_package_lock()
    validate_cargo_lock()
    validate_e2e_gates()
    validate_wrangler()
    validate_migrations()
    validate_product_scope()
    print("Static validation passed: binding specification resources, forward migrations, scoped RAG, training lifecycle, locked dependencies and existing product gates are consistent.")
