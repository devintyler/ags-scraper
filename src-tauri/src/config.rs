use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use zeroize::Zeroizing;

#[derive(Deserialize, Serialize, Default)]
pub struct Config {
    #[serde(default)]
    pub screenscraper: ScreenScraperConfig,
    #[serde(default)]
    pub steamgriddb: SteamGridDbConfig,
    #[serde(default)]
    pub ui: UiConfig,
}

#[derive(Deserialize, Serialize, Default)]
pub struct ScreenScraperConfig {
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password_enc: String,
}

#[derive(Deserialize, Serialize, Default)]
pub struct SteamGridDbConfig {
    #[serde(default)]
    pub api_key_enc: String,
}

#[derive(Deserialize, Serialize, Default)]
pub struct UiConfig {
    #[serde(default)]
    pub last_output_dir: String,
}

pub fn config_path() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "%APPDATA% is not set — cannot locate config directory".to_string())?;
    Ok(PathBuf::from(appdata).join("agsp-scraper").join("config.toml"))
}

pub fn load_config() -> Result<Config, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(Config::default());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config: {e}"))?;
    toml::from_str(&content)
        .map_err(|e| format!("Config file is malformed: {e}"))
}

pub fn save_config(config: &Config) -> Result<(), String> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = toml::to_string(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn encrypt(plaintext: &str) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    if plaintext.is_empty() {
        return Ok(String::new());
    }

    // Zeroizing ensures this copy of the plaintext bytes is wiped from memory when dropped.
    let mut bytes = Zeroizing::new(plaintext.as_bytes().to_vec());
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    unsafe {
        CryptProtectData(
            &input,
            windows::core::PCWSTR::null(),
            None,
            None,
            None,
            0u32,
            &mut output,
        )
        .map_err(|e| format!("CryptProtectData failed: {e}"))?;

        let encrypted =
            std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(Some(HLOCAL(output.pbData as *mut _)));

        Ok(STANDARD.encode(encrypted))
    }
}

#[cfg(target_os = "windows")]
#[allow(dead_code)] // used in Phase 2+ when making API calls
pub fn decrypt(blob: &str) -> Result<SecretString, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    if blob.is_empty() {
        return Ok(SecretString::new(String::new()));
    }

    // Zeroizing ensures the base64-decoded ciphertext bytes are wiped when dropped.
    let mut bytes = Zeroizing::new(
        STANDARD
            .decode(blob)
            .map_err(|e| format!("base64 decode failed: {e}"))?,
    );
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            0u32,
            &mut output,
        )
        .map_err(|e| format!("CryptUnprotectData failed: {e}"))?;

        // Wrap DPAPI output in Zeroizing so the plaintext bytes are wiped after we copy
        // them into the returned String.
        let decrypted = Zeroizing::new(
            std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec(),
        );
        LocalFree(Some(HLOCAL(output.pbData as *mut _)));

        std::str::from_utf8(&decrypted)
            .map_err(|e| format!("UTF-8 decode failed: {e}"))
            .map(|s| SecretString::new(s.to_string()))
    }
}
