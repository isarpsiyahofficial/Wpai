use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Manager};

const MAX_OUTPUT: usize = 2_000_000;

fn validate_device_id(value: &str) -> Result<(), String> {
    if !(20..=500).contains(&value.len()) || value.chars().any(char::is_whitespace) {
        return Err("WPAI cihaz kimliği geçersiz.".into());
    }
    Ok(())
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
    if !root.join("oauth-device-bootstrap.mjs").is_file()
        || !root.join("runtime").join("node.exe").is_file()
    {
        return Err("WPAI otomatik Cloudflare bağlantı motoru pakette bulunamadı.".into());
    }
    Ok(root)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|_| "Cloudflare çalışma klasörü oluşturulamadı.".to_string())?;
    for entry in fs::read_dir(source).map_err(|_| "Paketlenmiş WPAI kaynakları okunamadı.".to_string())? {
        let entry = entry.map_err(|_| "Paketlenmiş WPAI kaydı okunamadı.".to_string())?;
        let file_type = entry.file_type().map_err(|_| "Paketlenmiş WPAI kayıt türü okunamadı.".to_string())?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)
                .map_err(|_| "Paketlenmiş WPAI dosyası kopyalanamadı.".to_string())?;
        }
    }
    Ok(())
}

fn prepare_project(app: &AppHandle, root: &Path) -> Result<PathBuf, String> {
    let source = root.join("project");
    if !source.join("package-lock.json").is_file() || !source.join("wrangler.jsonc").is_file() {
        return Err("WPAI Cloudflare dağıtım kaynakları Windows paketinde eksik.".into());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "WPAI veri klasörü bulunamadı.".to_string())?;
    let destination = node_compatible_path(&app_data.join("cloudflare-oauth-bootstrap").join("project"));
    if destination.exists() {
        fs::remove_dir_all(&destination)
            .map_err(|_| "Eski Cloudflare çalışma alanı temizlenemedi.".to_string())?;
    }
    copy_tree(&source, &destination)?;
    Ok(destination)
}

fn sanitize(value: String) -> String {
    value.replace(['\r', '\n'], " ").chars().take(1800).collect()
}

fn execute(app: &AppHandle, payload: Value) -> Result<Value, String> {
    let root = bootstrap_root(app)?;
    let project = prepare_project(app, &root)?;
    let node = node_compatible_path(&root.join("runtime").join("node.exe"));
    let script = node_compatible_path(&root.join("oauth-device-bootstrap.mjs"));
    let input = serde_json::to_vec(&payload)
        .map_err(|_| "Otomatik Cloudflare bağlantı isteği hazırlanamadı.".to_string())?;

    let mut command = Command::new(&node);
    command
        .arg(&script)
        .current_dir(&root)
        .env("WPAI_BOOTSTRAP_ROOT", &root)
        .env("WPAI_PROJECT_DIR", &project)
        .env("WPAI_NODE_PATH", &node)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Otomatik Cloudflare bağlantı motoru başlatılamadı: {}", sanitize(error.to_string())))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "Otomatik Cloudflare bağlantı girişi açılamadı.".to_string())?
        .write_all(&input)
        .map_err(|_| "Otomatik Cloudflare bağlantı isteği iletilemedi.".to_string())?;
    let output = child
        .wait_with_output()
        .map_err(|_| "Otomatik Cloudflare bağlantı motoru tamamlanamadı.".to_string())?;
    if output.stdout.len() > MAX_OUTPUT || output.stderr.len() > MAX_OUTPUT {
        return Err("Otomatik Cloudflare bağlantı motoru beklenmeyen büyüklükte çıktı üretti.".into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parsed = serde_json::from_str::<Value>(&stdout).map_err(|_| {
        format!(
            "Otomatik Cloudflare bağlantı cevabı okunamadı. {}",
            sanitize(String::from_utf8_lossy(&output.stderr).to_string())
        )
    })?;
    if !output.status.success() || parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Otomatik Cloudflare bağlantısı tamamlanamadı.");
        return Err(sanitize(message.to_string()));
    }
    Ok(parsed)
}

#[tauri::command(rename_all = "camelCase")]
pub fn cloudflare_auto_bootstrap(app: AppHandle, device_id: String) -> Result<Value, String> {
    let device_id = device_id.trim().to_string();
    validate_device_id(&device_id)?;
    execute(
        &app,
        json!({
            "action": "bootstrap",
            "deviceId": device_id,
            "deviceName": "WPAI Windows",
            "appVersion": env!("CARGO_PKG_VERSION")
        }),
    )
}

#[tauri::command]
pub fn cloudflare_oauth_login(app: AppHandle) -> Result<Value, String> {
    execute(&app, json!({ "action": "login" }))
}

#[cfg(test)]
mod tests {
    use super::validate_device_id;

    #[test]
    fn validates_device_ids_before_oauth_bootstrap() {
        assert!(validate_device_id(&format!("device-{}", "a".repeat(40))).is_ok());
        assert!(validate_device_id("short").is_err());
        assert!(validate_device_id(&format!("device-{} ", "a".repeat(40))).is_err());
    }
}
