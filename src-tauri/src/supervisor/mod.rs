//! supervisord erişim katmanı: XML-RPC kodlama, çoklu taşıma connector'ları ve
//! (Faz 4) yüksek seviyeli supervisorService işlemleri.

pub mod config;
pub mod connector;
pub mod connectors;
pub mod http;
pub mod service;
pub mod xmlrpc;

pub use connectors::create_connector;
