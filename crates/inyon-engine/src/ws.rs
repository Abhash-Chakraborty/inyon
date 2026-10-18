//! Outbound WebSockets (to a hub's /node, to a relay), with TLS from rustls on ring and the
//! Mozilla root certificates, the same set the Bun engine trusted.

use std::sync::Arc;

use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Accepts any certificate, for NODE_TLS_REJECT_UNAUTHORIZED=0 (which Bun honoured too).
#[derive(Debug)]
struct NoCheck(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for NoCheck {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn tls() -> Arc<rustls::ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions().expect("ring supports TLS 1.2 and 1.3");
    let config = if crate::http::insecure_tls() {
        builder.dangerous().with_custom_certificate_verifier(Arc::new(NoCheck(provider))).with_no_client_auth()
    } else {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        builder.with_root_certificates(roots).with_no_client_auth()
    };
    Arc::new(config)
}

/// Opens a WebSocket to `url` with extra `headers`. The error is a WebSocket close code the way a
/// browser reports a socket that never opened (1006), plus why.
pub async fn connect(url: &str, headers: &[(&str, &str)]) -> Result<Socket, (u16, String)> {
    let mut req = url.into_client_request().map_err(|e| (1006, e.to_string()))?;
    for (k, v) in headers {
        let name = tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(k.as_bytes()).map_err(|e| (1006, e.to_string()))?;
        let value = tokio_tungstenite::tungstenite::http::HeaderValue::from_str(v).map_err(|e| (1006, e.to_string()))?;
        req.headers_mut().insert(name, value);
    }
    let config = WebSocketConfig::default().max_message_size(Some(64 << 20)).max_frame_size(Some(64 << 20));
    let connect = tokio_tungstenite::connect_async_tls_with_config(req, Some(config), false, Some(Connector::Rustls(tls())));
    match tokio::time::timeout(std::time::Duration::from_secs(30), connect).await {
        Ok(Ok((ws, _))) => Ok(ws),
        Ok(Err(e)) => Err((1006, e.to_string())),
        Err(_) => Err((1006, "timed out".into())),
    }
}
