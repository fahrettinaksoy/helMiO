//! Minimal XML-RPC kodlayıcı/çözücü — supervisord API'si için.
//!
//! Değerler `serde_json::Value` ile temsil edilir (uygulamanın geri kalanıyla
//! aynı tip). supervisord'un kullandığı dar değer kümesi desteklenir:
//! int/i4, boolean, double, string, base64, dateTime.iso8601, array, struct.

use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

/// Bir methodCall gövdesi üretir.
pub fn build_request(method: &str, params: &[Value]) -> String {
    let mut s = String::with_capacity(256);
    s.push_str("<?xml version=\"1.0\"?><methodCall><methodName>");
    escape_into(method, &mut s);
    s.push_str("</methodName><params>");
    for p in params {
        s.push_str("<param>");
        encode_value(p, &mut s);
        s.push_str("</param>");
    }
    s.push_str("</params></methodCall>");
    s
}

fn encode_value(v: &Value, out: &mut String) {
    out.push_str("<value>");
    match v {
        Value::Null => out.push_str("<string></string>"),
        Value::Bool(b) => {
            out.push_str("<boolean>");
            out.push(if *b { '1' } else { '0' });
            out.push_str("</boolean>");
        }
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.push_str("<int>");
                out.push_str(&i.to_string());
                out.push_str("</int>");
            } else {
                out.push_str("<double>");
                out.push_str(&n.as_f64().unwrap_or(0.0).to_string());
                out.push_str("</double>");
            }
        }
        Value::String(s) => {
            out.push_str("<string>");
            escape_into(s, out);
            out.push_str("</string>");
        }
        Value::Array(arr) => {
            out.push_str("<array><data>");
            for item in arr {
                encode_value(item, out);
            }
            out.push_str("</data></array>");
        }
        Value::Object(map) => {
            out.push_str("<struct>");
            for (k, val) in map {
                out.push_str("<member><name>");
                escape_into(k, out);
                out.push_str("</name>");
                encode_value(val, out);
                out.push_str("</member>");
            }
            out.push_str("</struct>");
        }
    }
    out.push_str("</value>");
}

fn escape_into(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
}

/// methodResponse gövdesini çözer. Fault → Err. Başarı → tek dönüş değeri.
pub fn parse_response(xml: &str) -> AppResult<Value> {
    let doc = roxmltree::Document::parse(xml)
        .map_err(|e| AppError::new(format!("XML-RPC yanıtı ayrıştırılamadı: {e}")))?;
    let root = doc.root_element();
    if root.tag_name().name() != "methodResponse" {
        return Err(AppError::new(
            "Geçersiz XML-RPC yanıtı (methodResponse yok)",
        ));
    }

    // <fault><value>...</value></fault>
    if let Some(fault) = root.children().find(|n| n.has_tag_name("fault")) {
        let val_node = fault
            .children()
            .find(|n| n.has_tag_name("value"))
            .ok_or_else(|| AppError::new("Bozuk XML-RPC fault"))?;
        let fault_val = parse_value(val_node);
        let msg = fault_val
            .get("faultString")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                let code = fault_val
                    .get("faultCode")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                format!("fault {code}")
            });
        return Err(AppError::new(format!("Supervisor hatası: {msg}")));
    }

    // <params><param><value>...</value></param></params>
    let value_node = root
        .descendants()
        .find(|n| n.has_tag_name("param"))
        .and_then(|p| p.children().find(|n| n.has_tag_name("value")));
    match value_node {
        Some(node) => Ok(parse_value(node)),
        None => Ok(Value::Null),
    }
}

/// Bir <value> düğümünü serde_json::Value'ya çevirir.
fn parse_value(value_node: roxmltree::Node) -> Value {
    // Tipli çocuk düğüm var mı?
    let typed = value_node.children().find(|n| n.is_element());
    let Some(node) = typed else {
        // Tipsiz: doğrudan metin → string.
        return Value::String(value_node.text().unwrap_or("").to_string());
    };

    match node.tag_name().name() {
        "int" | "i4" => node
            .text()
            .and_then(|t| t.trim().parse::<i64>().ok())
            .map(Value::from)
            .unwrap_or(Value::Null),
        "boolean" => Value::Bool(node.text().map(|t| t.trim() == "1").unwrap_or(false)),
        "double" => node
            .text()
            .and_then(|t| t.trim().parse::<f64>().ok())
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        "string" | "base64" | "dateTime.iso8601" => {
            Value::String(node.text().unwrap_or("").to_string())
        }
        "array" => {
            let mut arr = Vec::new();
            if let Some(data) = node.children().find(|n| n.has_tag_name("data")) {
                for v in data.children().filter(|n| n.has_tag_name("value")) {
                    arr.push(parse_value(v));
                }
            }
            Value::Array(arr)
        }
        "struct" => {
            let mut map = Map::new();
            for member in node.children().filter(|n| n.has_tag_name("member")) {
                let name = member
                    .children()
                    .find(|n| n.has_tag_name("name"))
                    .and_then(|n| n.text())
                    .unwrap_or("")
                    .to_string();
                let val = member
                    .children()
                    .find(|n| n.has_tag_name("value"))
                    .map(parse_value)
                    .unwrap_or(Value::Null);
                if !name.is_empty() {
                    map.insert(name, val);
                }
            }
            Value::Object(map)
        }
        _ => Value::String(node.text().unwrap_or("").to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn build_simple() {
        let req = build_request("supervisor.getState", &[]);
        assert!(req.contains("<methodName>supervisor.getState</methodName>"));
    }

    #[test]
    fn build_and_params() {
        let req = build_request("supervisor.startProcess", &[json!("web:app"), json!(true)]);
        assert!(req.contains("<string>web:app</string>"));
        assert!(req.contains("<boolean>1</boolean>"));
    }

    #[test]
    fn parse_struct_response() {
        let xml = r#"<?xml version="1.0"?><methodResponse><params><param><value><struct>
            <member><name>statecode</name><value><int>20</int></value></member>
            <member><name>statename</name><value><string>RUNNING</string></value></member>
        </struct></value></param></params></methodResponse>"#;
        let v = parse_response(xml).unwrap();
        assert_eq!(v["statecode"], json!(20));
        assert_eq!(v["statename"], json!("RUNNING"));
    }

    #[test]
    fn parse_array_response() {
        let xml = r#"<?xml version="1.0"?><methodResponse><params><param><value><array><data>
            <value><string>a</string></value>
            <value><int>2</int></value>
        </data></array></value></param></params></methodResponse>"#;
        let v = parse_response(xml).unwrap();
        assert_eq!(v, json!(["a", 2]));
    }

    #[test]
    fn parse_fault() {
        let xml = r#"<?xml version="1.0"?><methodResponse><fault><value><struct>
            <member><name>faultCode</name><value><int>10</int></value></member>
            <member><name>faultString</name><value><string>BAD_NAME</string></value></member>
        </struct></value></fault></methodResponse>"#;
        let err = parse_response(xml).unwrap_err();
        assert!(err.error.contains("BAD_NAME"));
    }

    #[test]
    fn escapes_special_chars() {
        let req = build_request("m", &[json!("a<b>&c")]);
        assert!(req.contains("a&lt;b&gt;&amp;c"));
    }
}
