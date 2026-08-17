use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Manager};

const ACCOUNT_ID: &str = "ad8e99c82c6c17d823f6877ff1efade4";
const KEYRING_SERVICE: &str = "WPAI Cloudflare Connection";
const KEYRING_USER: &str = "ad8e99c82c6c17d823f6877ff1efade4";
const SESSION_KEYRING_SERVICE: &str = "WPAI Desktop Session";
const SESSION_KEYRING_USER: &str = "refresh-token";
const MAX_ENGINE_OUTPUT: usize = 2_000_000;
const BUILD_ACTIVATION_TOKEN: Option<&str> = option_env!("WPAI_DESKTOP_ACTIVATION_TOKEN");

fn validate_account_id(value: &str) -> Result<(), String> {
    if value != ACCOUNT_ID {
        return Err("Cloudflare Account ID proje hesabıyla eşleşmiyor.".into());
    }
    Ok(())
}

fn validate_api_token(value: &str) -> Result<(), String> {
    if !(30..=4096).contains(&value.len()) || value.chars().any(char::is_whitespace) {
        return Err("Cloudflare API tokeni geçersiz.".into());
    }
    Ok(())
}

fn validate_device_id(value: &str) -> Result<(), String> {
    if !(20..=500).contains(&value.len()) || value.chars().any(char::is_whitespace) {
        return Err("WPAI cihaz kimliği geçersiz.".into());
    }
    Ok(())
}

fn activation_token() -> Option<&'static str> {
    let value = BUILD_ACTIVATION_TOKEN?.trim();
    if (40..=500).contains(&value.len()) && !value.chars().any(char::is_whitespace) {
        Some(value)
    } else {
        None
    }
}

fn activation_marker_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "WPAI veri klasörü bulunamadı.".to_string())?
        .join("device-activation-disabled"))
}

fn activation_disabled(app: &AppHandle) -> bool {
    let Some(token) = activation_token() else { return false; };
    let Ok(path) = activation_marker_path(app) else { return false; };
    fs::read_to_string(path)
        .map(|value| value.trim() == token)
        .unwrap_or(false)
}

fn set_activation_disabled(app: &AppHandle, disabled: bool) -> Result<(), String> {
    let path = activation_marker_path(app)?;
    if disabled {
        let Some(token) = activation_token() else { return Ok(()); };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| "WPAI veri klasörü oluşturulamadı.".to_string())?;
        }
        fs::write(path, token.as_bytes()).map_err(|_| "Cihaz etkinleştirme tercihi kaydedilemedi.".to_string())?;
    } else if path.exists() {
        fs::remove_file(path).map_err(|_| "Cihaz etkinleştirme tercihi temizlenemedi.".to_string())?;
    }
    Ok(())
}

fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|_| "Windows Credential Manager açılamadı.".to_string())
}

fn desktop_session_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SESSION_KEYRING_SERVICE, SESSION_KEYRING_USER)
        .map_err(|_| "Windows Credential Manager açılamadı.".to_string())
}

fn has_desktop_session() -> Result<bool, String> {
    match desktop_session_entry()?.get_password() {
        Ok(value) => Ok((32..=1000).contains(&value.len()) && !value.chars().any(char::is_whitespace)),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err("Kayıtlı cihaz oturumu okunamadı.".to_string()),
    }
}

fn remove_desktop_session() -> Result<(), String> {
    match desktop_session_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Kayıtlı cihaz oturumu kaldırılamadı.".to_string()),
    }
}

fn load_api_token() -> Result<Option<String>, String> {
    match credential_entry()?.get_password() {
        Ok(value) => {
            validate_api_token(&value)?;
            Ok(Some(value))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Kayıtlı Cloudflare bağlantısı okunamadı.".into()),
    }
}

fn save_api_token(value: &str) -> Result<(), String> {
    validate_api_token(value)?;
    credential_entry()?
        .set_password(value)
        .map_err(|_| "Cloudflare bağlantısı Windows Credential Manager'a kaydedilemedi.".to_string())
}

fn remove_api_token() -> Result<(), String> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Cloudflare bağlantısı Windows Credential Manager'dan kaldırılamadı.".into()),
    }
}

fn resolve_token(api_token: Option<String>) -> Result<(String, bool), String> {
    if let Some(value) = api_token {
        let trimmed = value.trim().to_string();
        validate_api_token(&trimmed)?;
        return Ok((trimmed, true));
    }
    let stored = load_api_token()?.ok_or_else(|| "Cloudflare API tokeni girin.".to_string())?;
    Ok((stored, false))
}

fn node_compatible_path(path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let value = path.as_os_str().to_string_lossy();
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

fn bootstrap_root(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|_| "WPAI paket kaynakları bulunamadı.".to_string())?;
    let root = node_compatible_path(&resource_dir.join("cloudflare-bootstrap"));
    if !root.join("bootstrap-v6.mjs").is_file()
        || !root.join("bootstrap.mjs").is_file()
        || !root.join("runtime").join("node.exe").is_file()
    {
        return Err("Cloudflare Device Bootstrap V6 Windows paketinde eksik.".into());
    }
    Ok(root)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|_| "Kurulum çalışma klasörü oluşturulamadı.".to_string())?;
    for entry in fs::read_dir(source).map_err(|_| "Paketlenmiş proje kaynakları okunamadı.".to_string())? {
        let entry = entry.map_err(|_| "Paketlenmiş proje kaydı okunamadı.".to_string())?;
        let file_type = entry.file_type().map_err(|_| "Paketlenmiş proje türü okunamadı.".to_string())?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target).map_err(|_| "Paketlenmiş proje dosyası kopyalanamadı.".to_string())?;
        }
    }
    Ok(())
}

fn prepare_project(app: &AppHandle, root: &Path) -> Result<PathBuf, String> {
    let source = root.join("project");
    if !source.join("package-lock.json").is_file() || !source.join("wrangler.jsonc").is_file() {
        return Err("Cloudflare dağıtım kaynakları Windows paketinde eksik.".into());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "WPAI veri klasörü bulunamadı.".to_string())?;
    let work_root = node_compatible_path(&app_data.join("cloudflare-bootstrap"));
    let destination = work_root.join("project");
    if destination.exists() {
        fs::remove_dir_all(&destination).map_err(|_| "Eski Cloudflare kurulum çalışma alanı temizlenemedi.".to_string())?;
    }
    copy_tree(&source, &destination)?;
    Ok(destination)
}

fn sanitize(mut value: String, secrets: &[&str]) -> String {
    for secret in secrets {
        if secret.len() >= 8 {
            value = value.replace(secret, "[REDACTED]");
        }
    }
    value.replace(['\r', '\n'], " ").chars().take(1800).collect()
}

fn execute_engine(
    node_path: &Path,
    script_path: &Path,
    root_path: &Path,
    project_path: &Path,
    payload: Value,
    token: &str,
) -> Result<Value, String> {
    let node_path = node_compatible_path(node_path);
    let script_path = node_compatible_path(script_path);
    let root_path = node_compatible_path(root_path);
    let project_path = node_compatible_path(project_path);
    let input = serde_json::to_vec(&payload).map_err(|_| "Cloudflare kurulum isteği hazırlanamadı.".to_string())?;

    let mut command = Command::new(&node_path);
    command
        .arg(&script_path)
        .current_dir(&root_path)
        .env("WPAI_BOOTSTRAP_ROOT", &root_path)
        .env("WPAI_PROJECT_DIR", &project_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|error| {
        format!(
            "Cloudflare kurulum motoru başlatılamadı: {}",
            sanitize(error.to_string(), &[token])
        )
    })?;
    child
        .stdin
        .take()
        .ok_or_else(|| "Cloudflare kurulum girişi açılamadı.".to_string())?
        .write_all(&input)
        .map_err(|_| "Cloudflare kurulum bilgileri motora iletilemedi.".to_string())?;
    let output = child.wait_with_output().map_err(|_| "Cloudflare kurulum motoru tamamlanamadı.".to_string())?;
    if output.stdout.len() > MAX_ENGINE_OUTPUT || output.stderr.len() > MAX_ENGINE_OUTPUT {
        return Err("Cloudflare kurulum motoru beklenmeyen büyüklükte çıktı üretti.".into());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parsed = serde_json::from_str::<Value>(&stdout).map_err(|_| {
        let detail = sanitize(
            format!(
                "stdout={} stderr={}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ),
            &[token],
        );
        format!("Cloudflare kurulum cevabı okunamadı. {detail}")
    })?;
    if !output.status.success() || parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Cloudflare kurulumu tamamlanamadı.");
        return Err(sanitize(message.to_string(), &[token]));
    }
    Ok(parsed)
}

fn run_engine(
    app: &AppHandle,
    mut payload: Value,
    token: &str,
    needs_project: bool,
) -> Result<Value, String> {
    let root = bootstrap_root(app)?;
    let project = if needs_project {
        prepare_project(app, &root)?
    } else {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|_| "WPAI veri klasörü bulunamadı.".to_string())?;
        node_compatible_path(&app_data.join("cloudflare-bootstrap").join("project"))
    };
    payload["apiToken"] = Value::String(token.to_string());
    execute_engine(
        &root.join("runtime").join("node.exe"),
        &root.join("bootstrap-v6.mjs"),
        &root,
        &project,
        payload,
        token,
    )
}

#[tauri::command]
pub fn cloudflare_connection_status(app: AppHandle) -> Result<Value, String> {
    let session_configured = has_desktop_session()?;
    let installer_activation = !activation_disabled(&app) && activation_token().is_some();
    let mode = if session_configured {
        "device_session"
    } else if installer_activation {
        "installer_activation"
    } else {
        "none"
    };
    Ok(json!({
        "configured": session_configured || installer_activation,
        "accountId": ACCOUNT_ID,
        "storage": "Windows Credential Manager",
        "mode": mode,
        "activationToken": if installer_activation { activation_token() } else { None }
    }))
}

#[tauri::command(rename_all = "camelCase")]
pub fn cloudflare_scan(app: AppHandle, account_id: String, api_token: Option<String>) -> Result<Value, String> {
    validate_account_id(&account_id)?;
    if api_token.is_none() && load_api_token()?.is_none() && (has_desktop_session()? || (!activation_disabled(&app) && activation_token().is_some())) {
        return Ok(json!({
            "ok": true,
            "mode": "device_session",
            "accountId": ACCOUNT_ID,
            "worker": "https://wa-ai-panel.wa-ai-panel.workers.dev",
            "message": "Cihaz oturumu etkin; Cloudflare API tokeni gerekmiyor."
        }));
    }
    let (token, supplied) = resolve_token(api_token)?;
    let result = run_engine(&app, json!({ "action": "scan", "accountId": account_id }), &token, false)?;
    if supplied {
        save_api_token(&token)?;
        set_activation_disabled(&app, false)?;
    }
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub fn cloudflare_repair(
    app: AppHandle,
    account_id: String,
    api_token: Option<String>,
    actions: Vec<String>,
) -> Result<Value, String> {
    validate_account_id(&account_id)?;
    if actions.len() > 20 {
        return Err("Cloudflare onarım listesi çok büyük.".into());
    }
    let (token, supplied) = resolve_token(api_token)?;
    let result = run_engine(
        &app,
        json!({ "action": "repair", "accountId": account_id, "actions": actions }),
        &token,
        false,
    )?;
    if supplied {
        save_api_token(&token)?;
        set_activation_disabled(&app, false)?;
    }
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub fn cloudflare_setup(
    app: AppHandle,
    account_id: String,
    api_token: String,
    device_id: String,
) -> Result<Value, String> {
    validate_account_id(&account_id)?;
    validate_api_token(api_token.trim())?;
    validate_device_id(device_id.trim())?;
    let token = api_token.trim().to_string();
    let device_id = device_id.trim().to_string();
    let result = run_engine(
        &app,
        json!({
            "action": "setup",
            "accountId": account_id,
            "deviceId": device_id,
            "deviceName": "WPAI Windows",
            "platform": "windows",
            "appVersion": env!("CARGO_PKG_VERSION")
        }),
        &token,
        true,
    )?;
    save_api_token(&token)?;
    set_activation_disabled(&app, false)?;
    Ok(result)
}

#[tauri::command]
pub fn cloudflare_forget(app: AppHandle) -> Result<Value, String> {
    remove_api_token()?;
    remove_desktop_session()?;
    set_activation_disabled(&app, true)?;
    Ok(json!({ "forgotten": true, "accountId": ACCOUNT_ID }))
}

#[cfg(test)]
mod tests {
    use super::{activation_token, execute_engine, node_compatible_path, validate_account_id, validate_api_token, validate_device_id, ACCOUNT_ID};
    use serde_json::json;
    use std::{path::PathBuf, process::Command};

    #[test]
    fn accepts_only_the_bound_cloudflare_account() {
        assert!(validate_account_id(ACCOUNT_ID).is_ok());
        assert!(validate_account_id("00000000000000000000000000000000").is_err());
    }

    #[test]
    fn rejects_short_or_whitespace_cloudflare_tokens() {
        assert!(validate_api_token(&"a".repeat(40)).is_ok());
        assert!(validate_api_token("short").is_err());
        assert!(validate_api_token(&format!("{} ", "a".repeat(40))).is_err());
    }

    #[test]
    fn rejects_invalid_device_ids() {
        assert!(validate_device_id(&format!("device-{}", "a".repeat(40))).is_ok());
        assert!(validate_device_id("short").is_err());
        assert!(validate_device_id(&format!("{} ", "a".repeat(40))).is_err());
    }

    #[test]
    fn optional_installer_activation_token_is_never_required_for_source_tests() {
        if let Some(value) = activation_token() {
            assert!(value.len() >= 40);
            assert!(!value.chars().any(char::is_whitespace));
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn strips_windows_verbatim_prefixes_before_node_execution() {
        assert_eq!(
            node_compatible_path(PathBuf::from(r"\\?\C:\Users\tester\WPAI").as_path()),
            PathBuf::from(r"C:\Users\tester\WPAI")
        );
        assert_eq!(
            node_compatible_path(PathBuf::from(r"\\?\UNC\server\share\WPAI").as_path()),
            PathBuf::from(r"\\server\share\WPAI")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn packaged_node_entrypoint_resolves_from_verbatim_paths() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repository_root = manifest_dir.parent().expect("repository root");
        let script = repository_root.join("desktop-bootstrap").join("bootstrap-v6.mjs");
        assert!(script.is_file(), "bootstrap-v6.mjs must exist for the Windows runtime test");

        let where_output = Command::new("where.exe")
            .arg("node.exe")
            .output()
            .expect("where.exe node.exe must run");
        assert!(where_output.status.success(), "Node.js must be available on the Windows test runner");
        let node = String::from_utf8_lossy(&where_output.stdout)
            .lines()
            .find(|line| !line.trim().is_empty())
            .map(str::trim)
            .map(PathBuf::from)
            .expect("node.exe path");

        let verbatim_root = PathBuf::from(format!(r"\\?\{}", repository_root.display()));
        let verbatim_script = PathBuf::from(format!(r"\\?\{}", script.display()));
        let error = execute_engine(
            &node,
            &verbatim_script,
            &verbatim_root,
            &verbatim_root,
            json!({
                "action": "invalid-runtime-self-test",
                "accountId": ACCOUNT_ID,
                "apiToken": "a".repeat(48)
            }),
            &"a".repeat(48),
        )
        .expect_err("invalid action must be returned as a parsed engine error");
        assert!(error.contains("Geçersiz Cloudflare bağlantı işlemi"), "unexpected error: {error}");
        assert!(!error.contains("EISDIR"), "Node received an incompatible verbatim path: {error}");
        assert!(!error.contains("cevabı okunamadı"), "engine output was not parsed: {error}");
    }
}
