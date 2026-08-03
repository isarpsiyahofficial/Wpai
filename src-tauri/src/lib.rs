use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

const KEYRING_SERVICE: &str = "WPAI";
const KEYRING_USER: &str = "cloudflare-api-token";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FaissMatch { id: String, score: f32, metadata: Value }

fn validate_cloudflare_token(token: &str) -> Result<(), String> {
    if !(30..=4096).contains(&token.len()) {
        return Err("Cloudflare tokeni geçersiz görünüyor.".into());
    }
    Ok(())
}

#[tauri::command]
fn save_cloudflare_token(token: String) -> Result<(), String> {
    validate_cloudflare_token(&token)?;
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|_| "Windows Credential Manager açılamadı.".to_string())?
        .set_password(&token)
        .map_err(|_| "Token Windows Credential Manager'a kaydedilemedi.".to_string())
}

#[tauri::command]
fn load_cloudflare_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|_| "Windows Credential Manager açılamadı.".to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Kayıtlı Cloudflare tokeni okunamadı.".to_string()),
    }
}

#[tauri::command]
fn remove_cloudflare_token() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|_| "Windows Credential Manager açılamadı.".to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Cloudflare tokeni kaldırılamadı.".to_string()),
    }
}

fn faiss_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|_| "Uygulama veri klasörü bulunamadı.".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|_| "Uygulama veri klasörü oluşturulamadı.".to_string())?;
    Ok(dir.join("faiss-index"))
}

async fn run_sidecar(app: &AppHandle, args: Vec<String>) -> Result<Value, String> {
    let output = app.shell().sidecar("faiss-service")
        .map_err(|_| "FAISS sidecar hazırlanamadı.".to_string())?
        .args(args)
        .output().await
        .map_err(|_| "FAISS sidecar çalıştırılamadı.".to_string())?;
    if !output.status.success() {
        let safe = String::from_utf8_lossy(&output.stderr).chars().take(300).collect::<String>();
        return Err(format!("FAISS işlemi başarısız: {safe}"));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "FAISS cevabı okunamadı.".to_string())
}

fn temp_json(app: &AppHandle, prefix: &str, value: &Value) -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let path = app.path().temp_dir().map_err(|_| "Geçici klasör bulunamadı.".to_string())?.join(format!("{prefix}-{}-{stamp}.json", std::process::id()));
    std::fs::write(&path, serde_json::to_vec(value).map_err(|_| "FAISS verisi hazırlanamadı.".to_string())?)
        .map_err(|_| "Geçici FAISS dosyası yazılamadı.".to_string())?;
    Ok(path)
}

#[tauri::command(rename_all = "camelCase")]
async fn faiss_upsert(app: AppHandle, id: String, vector: Vec<f32>, metadata: Value) -> Result<Value, String> {
    if id.is_empty() || id.len() > 128 || vector.is_empty() || vector.len() > 4096 { return Err("FAISS kaydı geçersiz.".into()); }
    let db = faiss_db_path(&app)?;
    let input = temp_json(&app, "wpai-faiss-upsert", &serde_json::json!([{ "id": id, "vector": vector, "metadata": metadata }]))?;
    let result = run_sidecar(&app, vec!["upsert".into(), "--db".into(), db.to_string_lossy().into_owned(), "--input".into(), input.to_string_lossy().into_owned()]).await;
    let _ = std::fs::remove_file(input);
    result
}

#[tauri::command(rename_all = "camelCase")]
async fn faiss_search(app: AppHandle, vector: Vec<f32>, top_k: usize) -> Result<Vec<FaissMatch>, String> {
    if vector.is_empty() || vector.len() > 4096 { return Err("FAISS sorgu vektörü geçersiz.".into()); }
    let db = faiss_db_path(&app)?;
    let input = temp_json(&app, "wpai-faiss-search", &serde_json::json!({ "vector": vector, "topK": top_k.clamp(1, 20) }))?;
    let value = run_sidecar(&app, vec!["search".into(), "--db".into(), db.to_string_lossy().into_owned(), "--input".into(), input.to_string_lossy().into_owned()]).await;
    let _ = std::fs::remove_file(input);
    serde_json::from_value(value?).map_err(|_| "FAISS arama sonucu okunamadı.".to_string())
}

#[tauri::command]
async fn faiss_health(app: AppHandle) -> Result<Value, String> { run_sidecar(&app, vec!["health".into()]).await }

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            save_cloudflare_token, load_cloudflare_token, remove_cloudflare_token,
            faiss_health, faiss_upsert, faiss_search
        ])
        .run(tauri::generate_context!())
        .expect("WPAI masaüstü uygulaması başlatılamadı");
}

#[cfg(test)]
mod tests {
    use super::validate_cloudflare_token;

    #[test]
    fn accepts_reasonable_cloudflare_token_length() {
        assert!(validate_cloudflare_token(&"x".repeat(30)).is_ok());
        assert!(validate_cloudflare_token(&"x".repeat(4096)).is_ok());
    }

    #[test]
    fn rejects_short_cloudflare_token() {
        assert!(validate_cloudflare_token("too-short").is_err());
    }

    #[test]
    fn rejects_oversized_cloudflare_token() {
        assert!(validate_cloudflare_token(&"x".repeat(4097)).is_err());
    }
}
