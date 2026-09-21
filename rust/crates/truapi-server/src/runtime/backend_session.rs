//! Sessions the core holds for backends that authenticate a person.
//!
//! A product asks for a backend call and gets one; whether that backend wants
//! a person proven first is between the core and the backend. The core runs
//! the handshake on first use of a backend, keeps the session it produced,
//! attaches it to every later call, and runs the handshake again once when a
//! backend refuses the one it holds. The same shape the CLI host already uses
//! against the identity backend.
//!
//! There is no consent gate here. Which backends a host serves at all is the
//! host vendor's decision, and the registry is where that decision lives; a
//! prompt would ask the person about a boundary they did not draw. The proof
//! discloses an alias bound to the product and to nothing else.

use std::collections::BTreeMap;
use std::sync::Mutex;

use truapi_platform::{BackendHost, ProductContext};

use crate::host_logic::backend::screen_authorization;
use crate::host_logic::backend::session::{self, Session};

/// How far before its stated expiry a session stops being used, so a call is
/// not sent with a token that expires in flight.
const EXPIRY_MARGIN_MS: u64 = 5_000;

/// What a personhood proof for a backend handshake consists of.
pub(crate) struct PersonProof {
    /// The ring-VRF proof, bound to the context and the challenge.
    pub(crate) proof: Vec<u8>,
    /// Index of the ring the proof opened against, which the backend needs to
    /// read the same commitment off chain.
    pub(crate) ring_index: u32,
}

/// The host role that can prove the connected person.
///
/// A signing host proves with the reserved `peopl.<suffix>` member key it
/// holds; a paired host asks the signer that holds it.
#[truapi::async_trait]
pub(crate) trait PersonhoodProver: Send + Sync {
    /// Prove the connected person against `context` and `message`.
    async fn prove_person(&self, context: &[u8], message: &[u8]) -> Result<PersonProof, ()>;
}

/// What a backend turned out to want, once the core has asked it.
enum Entry {
    /// A session, good until it expires or is refused.
    Held(Session),
    /// This backend answered the challenge path with something that is not
    /// this handshake, so there is no session to be had and no reason to ask
    /// again.
    NoHandshake,
}

/// Sessions held per backend, for one product execution.
#[derive(Default)]
pub(crate) struct BackendSessions {
    entries: Mutex<BTreeMap<String, Entry>>,
}

impl BackendSessions {
    /// The credential to attach to a call, running the handshake if this is
    /// the first use of the backend or the held session has expired.
    pub(crate) async fn authorization(
        &self,
        host: &dyn BackendHost,
        prover: &dyn PersonhoodProver,
        product: &ProductContext,
        backend: &str,
        now_ms: u64,
    ) -> Option<String> {
        match self.cached(backend, now_ms) {
            Some(Cached::Token(token)) => return Some(token),
            Some(Cached::NoHandshake) => return None,
            None => {}
        }
        self.authenticate(host, prover, product, backend).await
    }

    /// Drop a session the backend refused and mint another, once.
    ///
    /// A `401` on a call the core authenticated means the token is stale in a
    /// way its stated expiry did not predict — a rotated signing key, a
    /// revoked product — and the person is still a person.
    pub(crate) async fn reauthenticate(
        &self,
        host: &dyn BackendHost,
        prover: &dyn PersonhoodProver,
        product: &ProductContext,
        backend: &str,
    ) -> Option<String> {
        self.forget(backend);
        self.authenticate(host, prover, product, backend).await
    }

    fn cached(&self, backend: &str, now_ms: u64) -> Option<Cached> {
        let entries = self.entries.lock().expect("backend session mutex poisoned");
        match entries.get(backend)? {
            Entry::NoHandshake => Some(Cached::NoHandshake),
            Entry::Held(session) => (session.expires_at_ms.saturating_sub(EXPIRY_MARGIN_MS)
                > now_ms)
                .then(|| Cached::Token(session.token.clone())),
        }
    }

    fn forget(&self, backend: &str) {
        self.entries
            .lock()
            .expect("backend session mutex poisoned")
            .remove(backend);
    }

    fn remember(&self, backend: &str, entry: Entry) {
        self.entries
            .lock()
            .expect("backend session mutex poisoned")
            .insert(backend.to_owned(), entry);
    }

    async fn authenticate(
        &self,
        host: &dyn BackendHost,
        prover: &dyn PersonhoodProver,
        product: &ProductContext,
        backend: &str,
    ) -> Option<String> {
        // The handshake rides the same tunnel the product's call will: the
        // core holds no origin of its own, and the host authenticates itself
        // on these two calls exactly as it will on the third.
        let challenge = host
            .backend_request(product, session::challenge_request(backend), None)
            .await
            .ok()
            .filter(|response| response.status == 200)
            .and_then(|response| session::parse_challenge(&response.body).ok());

        let Some(challenge) = challenge else {
            // Either this backend serves no handshake, or it serves one this
            // core does not speak. Both mean the same thing to the call about
            // to go out, and asking again on every call would put two dead
            // round trips in front of each one.
            self.remember(backend, Entry::NoHandshake);
            return None;
        };

        let context = session::proof_context(&product.product_id);
        let proof = prover.prove_person(&context, &challenge.bytes).await.ok()?;

        let redeemed = host
            .backend_request(
                product,
                session::redeem_request(
                    backend,
                    &challenge,
                    &proof.proof,
                    proof.ring_index,
                    &product.product_id,
                ),
                None,
            )
            .await
            .ok()
            .filter(|response| response.status == 200)
            .and_then(|response| session::parse_session(&response.body).ok())
            // What a backend hands back becomes a header on the host's own
            // request, so it is held to the same rule as anything else that
            // does.
            .filter(|session| screen_authorization(&session.token).is_ok())?;

        let token = redeemed.token.clone();
        self.remember(backend, Entry::Held(redeemed));
        Some(token)
    }
}

enum Cached {
    Token(String),
    NoHandshake,
}

/// Wall clock in milliseconds, for comparing a session's stated expiry.
pub(crate) fn now_ms() -> u64 {
    #[cfg(target_arch = "wasm32")]
    let now = web_time::SystemTime::now().duration_since(web_time::UNIX_EPOCH);
    #[cfg(not(target_arch = "wasm32"))]
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
    now.map(|since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use truapi::latest::{HostBackendError, HostBackendListResponse, HostBackendResponse};

    /// A backend that speaks the handshake, counting what it was asked.
    #[derive(Default)]
    struct StubBackend {
        challenges: AtomicUsize,
        redeems: AtomicUsize,
        plain_calls: AtomicUsize,
        /// Status the challenge path answers with.
        challenge_status: u16,
        /// Token minted by each redemption, suffixed by the redeem count.
        expires_at_ms: u64,
    }

    impl StubBackend {
        fn serving() -> Self {
            Self {
                challenge_status: 200,
                expires_at_ms: 10_000,
                ..Self::default()
            }
        }

        fn without_a_handshake() -> Self {
            Self {
                challenge_status: 404,
                ..Self::default()
            }
        }
    }

    #[truapi::async_trait]
    impl BackendHost for StubBackend {
        async fn backend_request(
            &self,
            _product: &ProductContext,
            request: truapi::latest::HostBackendRequest,
            _authorization: Option<String>,
        ) -> Result<HostBackendResponse, HostBackendError> {
            let (status, body) = match request.path.as_str() {
                session::CHALLENGE_PATH => {
                    self.challenges.fetch_add(1, Ordering::SeqCst);
                    (
                        self.challenge_status,
                        br#"{"challenge":"AAECAwQF"}"#.to_vec(),
                    )
                }
                session::REDEEM_PATH => {
                    let nth = self.redeems.fetch_add(1, Ordering::SeqCst);
                    (
                        200,
                        format!(
                            r#"{{"token":"session-{nth}","expiresAtMs":{}}}"#,
                            self.expires_at_ms
                        )
                        .into_bytes(),
                    )
                }
                _ => {
                    self.plain_calls.fetch_add(1, Ordering::SeqCst);
                    (200, b"{}".to_vec())
                }
            };
            Ok(HostBackendResponse {
                status,
                headers: Vec::new(),
                body,
            })
        }

        async fn backends(
            &self,
            _product: &ProductContext,
        ) -> Result<HostBackendListResponse, truapi::latest::GenericError> {
            Ok(HostBackendListResponse {
                backends: vec!["fiat-onramp".to_string()],
            })
        }
    }

    #[derive(Default)]
    struct StubProver {
        proofs: AtomicUsize,
        /// Context of the last proof, to check what it was bound to.
        context: Mutex<Vec<u8>>,
        message: Mutex<Vec<u8>>,
    }

    #[truapi::async_trait]
    impl PersonhoodProver for StubProver {
        async fn prove_person(&self, context: &[u8], message: &[u8]) -> Result<PersonProof, ()> {
            self.proofs.fetch_add(1, Ordering::SeqCst);
            *self.context.lock().expect("context mutex") = context.to_vec();
            *self.message.lock().expect("message mutex") = message.to_vec();
            Ok(PersonProof {
                proof: vec![0xaa, 0xbb],
                ring_index: 3,
            })
        }
    }

    fn product() -> ProductContext {
        ProductContext::new("onramp.dot".to_string()).expect("valid product id")
    }

    #[test]
    fn a_session_is_minted_once_and_then_reused() {
        let backend = StubBackend::serving();
        let prover = StubProver::default();
        let sessions = BackendSessions::default();

        let first = futures::executor::block_on(sessions.authorization(
            &backend,
            &prover,
            &product(),
            "fiat-onramp",
            0,
        ));
        let second = futures::executor::block_on(sessions.authorization(
            &backend,
            &prover,
            &product(),
            "fiat-onramp",
            1_000,
        ));

        assert_eq!(first.as_deref(), Some("session-0"));
        assert_eq!(second.as_deref(), Some("session-0"));
        assert_eq!(backend.challenges.load(Ordering::SeqCst), 1);
        assert_eq!(prover.proofs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_proof_is_bound_to_the_product_and_to_the_challenge() {
        let backend = StubBackend::serving();
        let prover = StubProver::default();
        let sessions = BackendSessions::default();

        futures::executor::block_on(sessions.authorization(
            &backend,
            &prover,
            &product(),
            "fiat-onramp",
            0,
        ));

        assert_eq!(
            *prover.context.lock().expect("context mutex"),
            b"onramp.dot".to_vec()
        );
        assert_eq!(
            *prover.message.lock().expect("message mutex"),
            vec![0, 1, 2, 3, 4, 5]
        );
    }

    #[test]
    fn a_session_close_to_expiry_is_replaced_before_it_is_sent() {
        let backend = StubBackend::serving();
        let prover = StubProver::default();
        let sessions = BackendSessions::default();

        futures::executor::block_on(sessions.authorization(
            &backend,
            &prover,
            &product(),
            "fiat-onramp",
            0,
        ));
        // Inside the margin: the token has not expired, but it would while the
        // call it was going to authenticate is in flight.
        let renewed = futures::executor::block_on(sessions.authorization(
            &backend,
            &prover,
            &product(),
            "fiat-onramp",
            6_000,
        ));

        assert_eq!(renewed.as_deref(), Some("session-1"));
        assert_eq!(backend.challenges.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_refused_session_is_replaced_rather_than_reused() {
        let backend = StubBackend::serving();
        let prover = StubProver::default();
        let sessions = BackendSessions::default();

        futures::executor::block_on(sessions.authorization(
            &backend,
            &prover,
            &product(),
            "fiat-onramp",
            0,
        ));
        let refreshed = futures::executor::block_on(sessions.reauthenticate(
            &backend,
            &prover,
            &product(),
            "fiat-onramp",
        ));

        assert_eq!(refreshed.as_deref(), Some("session-1"));
        assert_eq!(prover.proofs.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_backend_without_a_handshake_is_asked_once_and_never_again() {
        let backend = StubBackend::without_a_handshake();
        let prover = StubProver::default();
        let sessions = BackendSessions::default();

        for now in [0, 1_000, 2_000] {
            assert_eq!(
                futures::executor::block_on(sessions.authorization(
                    &backend,
                    &prover,
                    &product(),
                    "echo",
                    now,
                )),
                None
            );
        }

        assert_eq!(backend.challenges.load(Ordering::SeqCst), 1);
        assert_eq!(
            prover.proofs.load(Ordering::SeqCst),
            0,
            "a backend that wants no proof must not cost one"
        );
    }
}
