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
const MAX_ENGINE_OUTPUT: usize = 2_000_000;

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

fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|_| "Windows Credential Manager açılamadı.".to_string())
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

fn bootstrap_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .resource_dir()
        .map_err(|_| "WPAI paket kaynakları bulunamadı.".to_string())?
        .join("cloudflare-bootstrap");
    if !root.join("bootstrap.mjs").is_file() || !root.join("runtime").join("node.exe").is_file() {
        return Err("Cloudflare kurulum motoru Windows paketinde eksik.".into());
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
    let work_root = app
        .path()
        .app_data_dir()
        .map_err(|_| "WPAI veri klasörü bulunamadı.".to_string())?
        .join("cloudflare-bootstrap");
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

fn run_engine(
    app: &AppHandle,
    mut payload: Value,
    token: &str,
    password: Option<&str>,
    needs_project: bool,
) -> Result<Value, String> {
    let root = bootstrap_root(app)?;
    let project = if needs_project {
        prepare_project(app, &root)?
    } else {
        app.path()
            .app_data_dir()
            .map_err(|_| "WPAI veri klasörü bulunamadı.".to_string())?
            .join("cloudflare-bootstrap")
            .join("project")
    };
    payload["apiToken"] = Value::String(token.to_string());
    let input = serde_json::to_vec(&payload).map_err(|_| "Cloudflare kurulum isteği hazırlanamadı.".to_string())?;

    let mut command = Command::new(root.join("runtime").join("node.exe"));
    command
        .arg(root.join("bootstrap.mjs"))
        .env("WPAI_BOOTSTRAP_ROOT", &root)
        .env("WPAI_PROJECT_DIR", &project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| "Cloudflare kurulum motoru başlatılamadı.".to_string())?;
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
        let detail = sanitize(String::from_utf8_lossy(&output.stderr).to_string(), &[token, password.unwrap_or("")]);
        format!("Cloudflare kurulum cevabı okunamadı. {detail}")
    })?;
    if !output.status.success() || parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Cloudflare kurulumu tamamlanamadı.");
        return Err(sanitize(message.to_string(), &[token, password.unwrap_or("")]));
    }
    Ok(parsed)
}

#[tauri::command]
pub fn cloudflare_connection_status() -> Result<Value, String> {
    Ok(json!({
        "configured": load_api_token()?.is_some(),
        "accountId": ACCOUNT_ID,
        "storage": "Windows Credential Manager"
    }))
}

#[tauri::command(rename_all = "camelCase")]
pub fn cloudflare_scan(app: AppHandle, account_id: String, api_token: Option<String>) -> Result<Value, String> {
    validate_account_id(&account_id)?;
    let (token, supplied) = resolve_token(api_token)?;
    let result = run_engine(&app, json!({ "action": "scan", "accountId": account_id }), &token, None, false)?;
    if supplied {
        save_api_token(&token)?;
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
        None,
        false,
    )?;
    if supplied {
        save_api_token(&token)?;
    }
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub fn cloudflare_setup(
    app: AppHandle,
    account_id: String,
    api_token: String,
    admin_name: String,
    admin_email: String,
    admin_password: String,
) -> Result<Value, String> {
    validate_account_id(&account_id)?;
    validate_api_token(api_token.trim())?;
    let token = api_token.trim().to_string();
    let result = run_engine(
        &app,
        json!({
            "action": "setup",
            "accountId": account_id,
            "adminName": admin_name,
            "adminEmail": admin_email,
            "adminPassword": admin_password
        }),
        &token,
        Some(&admin_password),
        true,
    )?;
    save_api_token(&token)?;
    Ok(result)
}

#[tauri::command]
pub fn cloudflare_forget() -> Result<Value, String> {
    remove_api_token()?;
    Ok(json!({ "forgotten": true, "accountId": ACCOUNT_ID }))
}

#[cfg(test)]
mod tests {
    use super::{validate_account_id, validate_api_token, ACCOUNT_ID};

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
}
