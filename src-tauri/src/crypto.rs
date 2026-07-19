//! Simetrik secret şifreleme (bağlantı parolaları, ingest token'ları, kanal
//! kimlik bilgileri) — eski Node backend `secretBox.js` ile BİREBİR uyumlu.
//!
//! AES-256-GCM, 32 baytlık anahtar. Şifreli değerler `enc:1:<base64(iv|tag|ct)>`
//! etiketiyle saklanır (iv 12 bayt, tag 16 bayt, ct sonda). Bu prefix'i taşımayan
//! değerler eski düz-metin sayılır ve olduğu gibi döndürülür (şeffaf geçiş —
//! sonraki yazımda şifrelenir).
//!
//! Anahtar çözümü: `HELMIO_SECRET_KEY` ortam değişkeni (herhangi bir metin,
//! SHA-256 ile 32 bayta indirgenir). Yoksa app config dizininde `.secret-key`
//! dosyasından hex okunur; o da yoksa rastgele üretilip 0600 ile yazılır.

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

const PREFIX: &str = "enc:1:";
const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;

pub struct SecretBox {
    key: [u8; 32],
}

impl SecretBox {
    /// Ortam değişkeni veya `dir/.secret-key` üzerinden anahtarı çözer/üretir.
    pub fn load(dir: &Path) -> Self {
        if let Ok(raw) = std::env::var("HELMIO_SECRET_KEY") {
            if !raw.is_empty() {
                let digest = Sha256::digest(raw.as_bytes());
                let mut key = [0u8; 32];
                key.copy_from_slice(&digest);
                return Self { key };
            }
        }

        let key_file = dir.join(".secret-key");
        if let Ok(hex_str) = std::fs::read_to_string(&key_file) {
            if let Ok(bytes) = hex::decode(hex_str.trim()) {
                if bytes.len() == 32 {
                    let mut key = [0u8; 32];
                    key.copy_from_slice(&bytes);
                    return Self { key };
                }
            }
        }

        // Üret + kalıcılaştır (0600).
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        if let Err(e) = std::fs::create_dir_all(dir) {
            log::error!("[helmio] secret dizini oluşturulamadı: {e}");
        }
        if let Err(e) = std::fs::write(&key_file, hex::encode(key)) {
            log::error!("[helmio] secret anahtarı yazılamadı: {e}");
        } else {
            set_owner_only(&key_file);
        }
        Self { key }
    }

    #[cfg(test)]
    pub fn from_key(key: [u8; 32]) -> Self {
        Self { key }
    }

    pub fn is_encrypted(value: &str) -> bool {
        value.starts_with(PREFIX)
    }

    /// Bir metni şifreler. Boş/zaten-şifreli değer olduğu gibi döner.
    pub fn encrypt(&self, value: &str) -> String {
        if value.is_empty() || Self::is_encrypted(value) {
            return value.to_string();
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key).expect("32 baytlık anahtar");
        let mut iv = [0u8; IV_LEN];
        rand::thread_rng().fill_bytes(&mut iv);
        let mut buf = value.as_bytes().to_vec();
        let tag = cipher
            .encrypt_in_place_detached(Nonce::from_slice(&iv), b"", &mut buf)
            .expect("aes-gcm şifreleme");
        let mut out = Vec::with_capacity(IV_LEN + TAG_LEN + buf.len());
        out.extend_from_slice(&iv);
        out.extend_from_slice(&tag);
        out.extend_from_slice(&buf);
        format!("{PREFIX}{}", B64.encode(out))
    }

    /// `encrypt` çıktısını çözer; eski düz-metni değiştirmeden döndürür.
    pub fn decrypt(&self, value: &str) -> String {
        if !Self::is_encrypted(value) {
            return value.to_string();
        }
        match self.try_decrypt(&value[PREFIX.len()..]) {
            Some(s) => s,
            None => {
                log::error!("[helmio] secret çözülemedi (yanlış anahtar?)");
                String::new()
            }
        }
    }

    fn try_decrypt(&self, b64: &str) -> Option<String> {
        let raw = B64.decode(b64).ok()?;
        if raw.len() < IV_LEN + TAG_LEN {
            return None;
        }
        let (iv, rest) = raw.split_at(IV_LEN);
        let (tag, ct) = rest.split_at(TAG_LEN);
        let cipher = Aes256Gcm::new_from_slice(&self.key).ok()?;
        let mut buf = ct.to_vec();
        cipher
            .decrypt_in_place_detached(Nonce::from_slice(iv), b"", &mut buf, Tag::from_slice(tag))
            .ok()?;
        String::from_utf8(buf).ok()
    }

    /// Bir JSON nesnesinin adı verilen alanlarını şifreler (yeni nesne döner).
    pub fn encrypt_fields(&self, obj: &Map<String, Value>, fields: &[&str]) -> Map<String, Value> {
        self.map_fields(obj, fields, |s| self.encrypt(s))
    }

    /// Adı verilen alanları çözer (yeni nesne döner). Faz 3+ (connector) kullanır.
    #[allow(dead_code)]
    pub fn decrypt_fields(&self, obj: &Map<String, Value>, fields: &[&str]) -> Map<String, Value> {
        self.map_fields(obj, fields, |s| self.decrypt(s))
    }

    fn map_fields<F: Fn(&str) -> String>(
        &self,
        obj: &Map<String, Value>,
        fields: &[&str],
        f: F,
    ) -> Map<String, Value> {
        let mut out = obj.clone();
        for &field in fields {
            if let Some(Value::String(s)) = out.get(field) {
                if !s.is_empty() {
                    let v = f(s);
                    out.insert(field.to_string(), Value::String(v));
                }
            }
        }
        out
    }
}

#[cfg(unix)]
fn set_owner_only(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_() -> SecretBox {
        SecretBox::from_key([7u8; 32])
    }

    #[test]
    fn round_trip() {
        let sb = box_();
        let enc = sb.encrypt("parola123");
        assert!(SecretBox::is_encrypted(&enc));
        assert_ne!(enc, "parola123");
        assert_eq!(sb.decrypt(&enc), "parola123");
    }

    #[test]
    fn empty_and_plaintext_passthrough() {
        let sb = box_();
        assert_eq!(sb.encrypt(""), "");
        // Eski düz-metin (prefix yok) çözülünce değişmez.
        assert_eq!(sb.decrypt("düz-metin"), "düz-metin");
    }

    #[test]
    fn double_encrypt_is_noop() {
        let sb = box_();
        let once = sb.encrypt("x");
        assert_eq!(sb.encrypt(&once), once);
    }

    #[test]
    fn wrong_key_fails_soft() {
        let enc = box_().encrypt("gizli");
        let other = SecretBox::from_key([9u8; 32]);
        assert_eq!(other.decrypt(&enc), ""); // sessiz boş, panik yok
    }
}
