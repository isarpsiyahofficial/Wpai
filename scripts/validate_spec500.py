from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALLOWED_STATUSES = {"implemented", "superseded_by_newer_requirement"}


def text(path: str) -> str:
    return (ROOT / path).read_text("utf-8")


def require(path: str, *needles: str) -> None:
    value = text(path)
    for needle in needles:
        if needle not in value:
            raise AssertionError(f"500-item gate missing in {path}: {needle}")


def forbid(path: str, *needles: str) -> None:
    value = text(path)
    for needle in needles:
        if needle in value:
            raise AssertionError(f"Superseded product flow returned in {path}: {needle}")


def validate_evidence_matrix() -> None:
    payload = json.loads(text("docs/SPEC-500-EVIDENCE.json"))
    if payload.get("format") != "wpai-spec-500-evidence" or payload.get("version") != 1:
        raise AssertionError("SPEC-500 evidence format/version is invalid")
    if payload.get("specSha256") != "5a8379efad0163f17afe608bc761809871a43de047f47c3fed5defef19cc42a3":
        raise AssertionError("Binding 500-item specification checksum changed")
    records = payload.get("records")
    if not isinstance(records, list) or len(records) != 500 or payload.get("ruleCount") != 500:
        raise AssertionError("Evidence matrix must contain exactly 500 records")
    ids = [record.get("id") for record in records if isinstance(record, dict)]
    if ids != list(range(1, 501)):
        raise AssertionError("Evidence matrix IDs must be exactly 1..500 in order")
    for record in records:
        item_id = record["id"]
        if record.get("status") not in ALLOWED_STATUSES:
            raise AssertionError(f"Rule {item_id} has an incomplete status: {record.get('status')}")
        if not str(record.get("requirementGroup", "")).strip():
            raise AssertionError(f"Rule {item_id} has no requirement group")
        for key in ("evidence", "tests", "verification"):
            values = record.get(key)
            if not isinstance(values, list) or not values:
                raise AssertionError(f"Rule {item_id} has no {key}")
        for relative in [*record["evidence"], *record["tests"]]:
            if not (ROOT / relative).exists():
                raise AssertionError(f"Rule {item_id} evidence path missing: {relative}")


def validate_versions_and_brand() -> None:
    package = json.loads(text("package.json"))
    lock = json.loads(text("package-lock.json"))
    tauri = json.loads(text("src-tauri/tauri.conf.json"))
    version = package["version"]
    if version != "1.3.6":
        raise AssertionError(f"Expected final audited version 1.3.6, got {version}")
    if lock.get("version") != version or lock.get("packages", {}).get("", {}).get("version") != version:
        raise AssertionError("npm package and lock versions differ")
    if tauri.get("version") != version:
        raise AssertionError("Tauri and npm versions differ")
    cargo = text("src-tauri/Cargo.toml")
    cargo_lock = text("src-tauri/Cargo.lock")
    if f'version = "{version}"' not in cargo:
        raise AssertionError("Cargo.toml version differs")
    if f'name = "wpai-desktop"\nversion = "{version}"' not in cargo_lock:
        raise AssertionError("Cargo.lock root version differs")
    require("src/frontend/api.ts", f"appVersion: '{version}'")
    require("desktop-bootstrap/bootstrap-core.mjs", f"appVersion: '{version}'")
    import subprocess
    subprocess.run(["python", str(ROOT / "scripts/sync_brand.py")], check=True, cwd=ROOT)


def validate_critical_runtime_gates() -> None:
    require("src-tauri/src/main.rs", 'windows_subsystem = "windows"')
    require("src-tauri/src/lib.rs", "faiss_search_text", '"search-text"', "tauri_plugin_single_instance::init")
    require("src-tauri/src/lib.rs", "oauth_bootstrap::cloudflare_auto_bootstrap", "oauth_bootstrap::cloudflare_oauth_login")
    require("src-tauri/permissions/default.toml", '"cloudflare_auto_bootstrap"', '"cloudflare_oauth_login"')
    require("src-tauri/build.rs", "rerun-if-env-changed=WPAI_DESKTOP_ACTIVATION_TOKEN", '"cloudflare_auto_bootstrap"', '"cloudflare_oauth_login"')
    require("sidecar/faiss_service.py", "TEXT_INDEX_VERSION", "text_vector", "search_text", 'text-index.faiss')
    require("sidecar/test_faiss_service.py", "offline_text_search", "TEXT_INDEX_REBUILD_REQUIRED")

    require(
        "src/frontend/App.tsx",
        "phase: 'connections'",
        "DesktopConnectionsPage",
        "cloudflareConnectionStatus",
        "restoreDesktopSession",
        "openCloudflareBrowserLogin",
        "Cloudflare Oturumunu Aç",
        "Cihaz Bağlantısını Yeniden Dene",
        "Kullanıcı adı, e-posta, parola veya Cloudflare API tokeni uygulamaya girilmez."
    )
    forbid(
        "src/frontend/App.tsx",
        "phase: 'offline'",
        "OfflineDesktopPage",
        "Yerel Bilgi Modu",
        "Buluta Yeniden Bağlan",
        "Cloudflare Kurulumu ve Onarımı",
        "Yönetici e-postası<input",
        "Yeni parola<input",
        "Parola tekrarı<input",
        "Panele Giriş Yap",
        'name="apiToken"',
        "Cloudflare User veya Account API Token"
    )
    require(
        "desktop-bootstrap/bootstrap-v6.mjs",
        "device-bootstrap-v6",
        "emailPromptRequired: false",
        "passwordPromptRequired: false",
        "Yeni cihaz oturumunu oluşturma"
    )
    require(
        "desktop-bootstrap/bootstrap-v6.test.mjs",
        "Linux scenario",
        "never asks for email or password",
        "never as a fake permission error"
    )
    require(
        "desktop-bootstrap/oauth-device-bootstrap.mjs",
        "WRANGLER_OAUTH_REQUIRED",
        "wrangler(['whoami'])",
        "wrangler(['login'])",
        "applyMigrations",
        "buildAndDeploy",
        "activationTicket",
        "activateDevice"
    )
    require(
        "desktop-bootstrap/oauth-device-bootstrap.test.mjs",
        "existing Wrangler OAuth",
        "missing Wrangler OAuth",
        "never receives administrator credentials"
    )
    require(
        "src-tauri/src/oauth_bootstrap.rs",
        "cloudflare_auto_bootstrap",
        "cloudflare_oauth_login",
        "oauth-device-bootstrap.mjs"
    )
    require("src/frontend/desktop.ts", "cloudflareAutoBootstrap", "cloudflareOauthLogin")
    require("src/frontend/api.ts", "bootstrapViaWranglerOAuth", "openCloudflareBrowserLogin", "bootstrapNewDesktopSession")
    require(
        "src/frontend/pages/settings.tsx",
        "WPAI Cihaz Bağlantısı",
        "WhatsApp / Meta Bağlantısı",
        "Cihaz Bağlantısını Doğrula",
        "Bu Cihazın Bağlantısını Kaldır",
        "D1, R2 ve müşteri verileri silinmez"
    )
    forbid(
        "src/frontend/pages/settings.tsx",
        'name="apiToken"',
        "Yeni Cloudflare API Token",
        "Cloudflare User veya Account API Token"
    )
    require("migrations/0010_desktop_activation_tokens.sql", "desktop_activation_tokens", "bound_device_hash", "expires_at")
    require("src/worker/desktopAuth.ts", "/desktop/activate", "DESKTOP_ACTIVATION_BOUND", "desktop_activation_tokens")
    require("tests/worker/device-activation.test.ts", "same installer ticket", "expired installer ticket")
    require("src/frontend/api.ts", "activateInstallerSession", "/api/auth/desktop/activate", "ensureDesktopOnline", "Çevrimdışıyken veri değiştirilemez")
    require("src/frontend/pages/desktopIndex.tsx", "faissSearchText")
    require("src/worker/trainingApi.ts", "/impact-preview", "training.impact_preview", "simulateTrainingAnswer")
    require("src/frontend/pages/training.tsx", "Canlı AI’a Etkisi", "Mevcut canlı cevap", "Taslak yayınlanırsa olası cevap")
    require("src/worker/vectorSync.ts", "totalSources", "completedJobs", "estimatedCostUsd", "estimatedRemainingSeconds")
    require("src/frontend/pages/training.tsx", "Tahmini indeks maliyeti", "Tahmini kalan süre", "Toplam bilgi parçası")
    require("src-tauri/windows/installer-hooks.nsh", "NSIS_HOOK_PREUNINSTALL", "/PURGELOCALCACHE", "faiss-index", "cloudflare-bootstrap")
    require("src-tauri/tauri.conf.json", "installerHooks", "installer-hooks.nsh")
    require(".github/workflows/windows-desktop.yml", "purgeOptionRemovedLocalCache", "silentUninstallPreservedLocalCache", "peSubsystem")
    require("tests/worker/training-vector.test.ts", "current and draft-assisted answer", "estimated cost and remaining time")
    require(
        "tests/e2e/offline-desktop.spec.mjs",
        "offline startup stays in Settings",
        "removing a saved device connection keeps it removed",
        "Yerel Bilgi Modu",
        "Cloudflare Account ID",
        'input[name="apiToken"]'
    )
    require(
        "tests/e2e/auth-regression.spec.mjs",
        "first launch activates the Windows device automatically",
        "existing Wrangler OAuth session",
        "Cloudflare Oturumunu Aç",
        "expired installer activation",
        'not.toHaveProperty(\'apiToken\')'
    )
    require("scripts/verify-installed-webview.mjs", "Gösterge Paneli", "WPAI Cihaz Bağlantısı", "cloudflareCredentialInputs: 0")


def validate_security_and_scope() -> None:
    package = json.loads(text("package.json"))
    lock = json.loads(text("package-lock.json"))
    if package.get("overrides", {}).get("nanoid") != "3.3.18":
        raise AssertionError("Patched Nano ID override is not pinned")
    if lock.get("packages", {}).get("node_modules/nanoid", {}).get("version") != "3.3.18":
        raise AssertionError("package-lock.json does not contain patched nanoid 3.3.18")
    if package.get("overrides", {}).get("undici") != "7.29.0":
        raise AssertionError("Patched Undici override is not pinned")
    if lock.get("packages", {}).get("node_modules/undici", {}).get("version") != "7.29.0":
        raise AssertionError("package-lock.json does not contain patched Undici 7.29.0")
    require("wrangler.jsonc", '"index_name": "wa-ai-knowledge-prod"', '"queue": "wa-knowledge-index"')
    require("README.md", "wa-ai-knowledge-prod", "AI varsayılan kapalıdır")
    require("src/worker/vectorSync.ts", "knowledgeId", "chunkId", "sourceId", "conversationId", "checksum", "language")
    require("tests/worker/training-vector.test.ts", "wrong-customer vectors", "prompt injection", "duplicate: true")
    require("tests/worker/meta-paused-queue.test.ts", "does not call Meta")
    worker_source = "\n".join(text(path) for path in (
        "src/worker/index.ts", "src/worker/api.ts", "src/worker/extendedApi.ts", "src/worker/operationsApi.ts"
    ))
    if re.search(r"(?:post|put|patch)\(['\"]?/campaign", worker_source, re.I):
        raise AssertionError("Campaign execution capability returned to active Worker source")
    defaults = text("migrations/0003_default_settings.sql")
    for expected in ('\'ai_global_mode\',\'"off"\'', "'ai_auto_reply_enabled','false'", "'ai_suggestion_mode','true'"):
        if expected not in defaults.replace(" ", ""):
            raise AssertionError(f"Safe AI default missing: {expected}")


def main() -> None:
    validate_evidence_matrix()
    validate_versions_and_brand()
    validate_critical_runtime_gates()
    validate_security_and_scope()
    print("500/500 evidence validation passed: Cloudflare connection remains Settings-only and desktop onboarding is credential-free while all security and runtime gates remain present.")


if __name__ == "__main__":
    main()
