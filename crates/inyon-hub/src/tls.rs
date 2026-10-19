//! HTTPS served by the hub itself (TLS_CERT and TLS_KEY, PEM files). Browsers only treat the app
//! as installable, and allow clipboard images and notifications, on HTTPS. Each handshake runs on
//! its own, so a slow client doesn't hold up the others.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;

pub fn config(cert: &str, key: &str) -> Result<Arc<rustls::ServerConfig>, String> {
    let certs: Vec<CertificateDer<'static>> =
        CertificateDer::pem_file_iter(cert).map_err(|e| format!("{cert}: {e}"))?.collect::<Result<_, _>>().map_err(|e| format!("{cert}: {e}"))?;
    if certs.is_empty() {
        return Err(format!("{cert} has no certificate"));
    }
    let key = PrivateKeyDer::from_pem_file(key).map_err(|e| format!("{key}: {e}"))?;
    let mut c = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| e.to_string())?;
    c.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(c))
}

pub struct TlsListener {
    rx: mpsc::Receiver<(TlsStream<TcpStream>, SocketAddr)>,
    local: SocketAddr,
}

impl TlsListener {
    pub fn new(listener: TcpListener, cfg: Arc<rustls::ServerConfig>) -> Self {
        let local = listener.local_addr().unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], 0)));
        let (tx, rx) = mpsc::channel(64);
        let acceptor = TlsAcceptor::from(cfg);
        tokio::spawn(async move {
            loop {
                let (tcp, addr) = match listener.accept().await {
                    Ok(c) => c,
                    Err(_) => {
                        // out of file descriptors and the like: wait a moment rather than spin
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let (acceptor, tx) = (acceptor.clone(), tx.clone());
                tokio::spawn(async move {
                    if let Ok(Ok(tls)) = tokio::time::timeout(Duration::from_secs(10), acceptor.accept(tcp)).await {
                        let _ = tx.send((tls, addr)).await;
                    }
                });
            }
        });
        TlsListener { rx, local }
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.rx.recv().await {
            Some(c) => c,
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        Ok(self.local)
    }
}
