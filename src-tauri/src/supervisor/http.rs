//! Herhangi bir bayt akışı (AsyncRead+AsyncWrite) üzerinde minimal HTTP/1.1
//! istemcisi. `reqwest`'in kapsamadığı taşımalar için: yerel Unix socket ve
//! (Faz 3B) SSH tünel kanalı. supervisord basit `Content-Length` yanıtları
//! döndürür; `Connection: close` ile EOF'a kadar okuyup gövdeyi ayırırız.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, AppResult};

/// XML-RPC POST'u akış üzerinden gönderir, yanıt gövdesini (XML) döndürür.
pub async fn post_xmlrpc<S>(
    mut stream: S,
    host: &str,
    path: &str,
    body: &str,
    basic_auth: Option<(&str, &str)>,
) -> AppResult<String>
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    let mut req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: text/xml\r\n\
         Content-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some((user, pass)) = basic_auth {
        let token = B64.encode(format!("{user}:{pass}"));
        req.push_str(&format!("Authorization: Basic {token}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);

    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| AppError::new(format!("İstek yazılamadı: {e}")))?;
    stream
        .flush()
        .await
        .map_err(|e| AppError::new(format!("İstek gönderilemedi: {e}")))?;

    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .await
        .map_err(|e| AppError::new(format!("Yanıt okunamadı: {e}")))?;

    // Başlık/gövde ayracı.
    let sep = b"\r\n\r\n";
    let idx = buf
        .windows(sep.len())
        .position(|w| w == sep)
        .ok_or_else(|| AppError::new("Bozuk HTTP yanıtı (başlık sonu yok)"))?;
    let body_bytes = &buf[idx + sep.len()..];
    String::from_utf8(body_bytes.to_vec())
        .map_err(|e| AppError::new(format!("Yanıt UTF-8 değil: {e}")))
}
