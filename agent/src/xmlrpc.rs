//! Minimal XML-RPC kodlayıcı/çözücü (bağımsız — ajan için). serde_json::Value.

use serde_json::{Map, Value};

pub fn build_request(method: &str, params: &[Value]) -> String {
    let mut s = String::with_capacity(256);
    s.push_str("<?xml version=\"1.0\"?><methodCall><methodName>");
    escape(method, &mut s);
    s.push_str("</methodName><params>");
    for p in params {
        s.push_str("<param>");
        encode(p, &mut s);
        s.push_str("</param>");
    }
    s.push_str("</params></methodCall>");
    s
}

fn encode(v: &Value, out: &mut String) {
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
                out.push_str(&format!("<int>{i}</int>"));
            } else {
                out.push_str(&format!("<double>{}</double>", n.as_f64().unwrap_or(0.0)));
            }
        }
        Value::String(st) => {
            out.push_str("<string>");
            escape(st, out);
            out.push_str("</string>");
        }
        Value::Array(arr) => {
            out.push_str("<array><data>");
            for item in arr {
                encode(item, out);
            }
            out.push_str("</data></array>");
        }
        Value::Object(map) => {
            out.push_str("<struct>");
            for (k, val) in map {
                out.push_str("<member><name>");
                escape(k, out);
                out.push_str("</name>");
                encode(val, out);
                out.push_str("</member>");
            }
            out.push_str("</struct>");
        }
    }
    out.push_str("</value>");
}

fn escape(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
}

pub fn parse_response(xml: &str) -> Result<Value, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("XML ayrıştırılamadı: {e}"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "methodResponse" {
        return Err("geçersiz XML-RPC yanıtı".to_string());
    }
    if let Some(fault) = root.children().find(|n| n.has_tag_name("fault")) {
        let val = fault
            .children()
            .find(|n| n.has_tag_name("value"))
            .map(parse_value);
        let msg = val
            .as_ref()
            .and_then(|v| v.get("faultString"))
            .and_then(Value::as_str)
            .unwrap_or("fault")
            .to_string();
        return Err(msg);
    }
    let node = root
        .descendants()
        .find(|n| n.has_tag_name("param"))
        .and_then(|p| p.children().find(|n| n.has_tag_name("value")));
    Ok(node.map(parse_value).unwrap_or(Value::Null))
}

fn parse_value(value_node: roxmltree::Node) -> Value {
    let Some(node) = value_node.children().find(|n| n.is_element()) else {
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
