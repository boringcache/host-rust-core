//! Credential-endpoint grants and the caller identity the host attaches to
//! every request one covers (RFC 0025).
//!
//! A grant names one `(domain, path, method)` triple. For each covered request
//! the host derives an sr25519 key scoped to that triple, signs a digest of the
//! request, and attaches the public key and signature. A consuming backend
//! verifies the signature and rate limits on the public key, which is stable
//! for one wallet calling one endpoint of one product and unrelated everywhere
//! else.
//!
//! Everything here is pure. The session secret arrives from the caller and the
//! clock and randomness are inputs, so the digest and the derivation are
//! reproducible from a test vector.

use schnorrkel::{ExpansionMode, Keypair, MiniSecretKey};
use thiserror::Error;
use truapi::latest::RemotePermission;
use url::Url;

use crate::host_logic::entropy::blake2b256_keyed;
use crate::host_logic::product_account::SR25519_SIGNING_CONTEXT;

/// Separates the credential key tree from RFC-0007 product entropy.
///
/// It keys the product-id layer, not the caller-supplied layer, so no argument
/// a product can pass to `host_derive_entropy` reaches this tree. Separating at
/// the caller layer instead would leave the product able to derive its own
/// credential keys and sign covered requests without a grant.
const CREDENTIAL_DOMAIN_SEPARATOR: &[u8] = b"credential-endpoint-derivation";

/// Labels the request digest, so a credential signature cannot be replayed as
/// any other signature this key tree produces.
const REQUEST_DIGEST_LABEL: &[u8] = b"truapi/credential-request/v1";

/// Public key identifying the caller. A backend rate limits on this value.
pub const HEADER_KEY: &str = "X-Polkadot-Key";
/// sr25519 signature over the request digest.
pub const HEADER_SIGNATURE: &str = "X-Polkadot-Signature";
/// Unix seconds the signature was made at.
pub const HEADER_TIMESTAMP: &str = "X-Polkadot-Timestamp";
/// Random bytes, fresh per request.
pub const HEADER_NONCE: &str = "X-Polkadot-Nonce";

/// Prefix the host reserves. A caller-supplied header matching it is stripped
/// before the host attaches its own, so a product cannot present an identity of
/// its choosing.
pub const HEADER_PREFIX: &str = "x-polkadot-";

/// Why a request is not covered by a credential grant.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum CredentialError {
    /// The URL does not parse, or carries no host.
    #[error("request URL is not a valid absolute URL")]
    InvalidUrl,
    /// Covered requests must be `https`: the signature would otherwise travel
    /// in plaintext, and a proxy could lift it onto another request.
    #[error("credential grants cover https only")]
    NotHttps,
    /// A grant names one exact endpoint. A wildcard would ask the user to
    /// reason about a set, which is what domain grants already do badly.
    #[error("credential grants take no wildcards")]
    Wildcard,
}

/// One `(domain, path, method)` triple in the canonical form the permission key
/// is built from: domain lower-cased, method upper-cased, path verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialGrant {
    /// Domain the grant covers.
    pub domain: String,
    /// Exact path the grant covers.
    pub path: String,
    /// HTTP method the grant covers.
    pub method: String,
}

impl CredentialGrant {
    /// The grant covering an outbound request, and the request's query string.
    ///
    /// The query is not part of the grant — a grant names an endpoint, not one
    /// call to it — but it is covered by the signature, so it is returned
    /// alongside rather than discarded.
    pub fn from_request(method: &str, url: &str) -> Result<(Self, String), CredentialError> {
        let parsed = Url::parse(url).map_err(|_| CredentialError::InvalidUrl)?;
        if parsed.scheme() != "https" {
            return Err(CredentialError::NotHttps);
        }
        let domain = parsed.host_str().ok_or(CredentialError::InvalidUrl)?;
        let grant = Self::new(domain, parsed.path(), method)?;
        Ok((grant, parsed.query().unwrap_or_default().to_string()))
    }

    /// Canonicalize a triple, rejecting wildcards.
    pub fn new(domain: &str, path: &str, method: &str) -> Result<Self, CredentialError> {
        if domain.contains('*') || path.contains('*') {
            return Err(CredentialError::Wildcard);
        }
        Ok(Self {
            domain: domain.to_ascii_lowercase(),
            path: path.to_string(),
            method: method.to_ascii_uppercase(),
        })
    }

    /// The permission this grant is stored and prompted under.
    pub fn permission(&self) -> RemotePermission {
        RemotePermission::Credential {
            domain: self.domain.clone(),
            path: self.path.clone(),
            method: self.method.clone(),
        }
    }

    /// The triple as one 32-byte value, keying the endpoint's slot in the
    /// product's credential key tree.
    pub fn digest(&self) -> [u8; 32] {
        let mut preimage = Vec::new();
        push_field(&mut preimage, self.method.as_bytes());
        push_field(&mut preimage, self.domain.as_bytes());
        push_field(&mut preimage, self.path.as_bytes());
        blake2b256_keyed(&preimage, &[])
    }
}

/// The digest a covered request is signed over.
///
/// Query and body are covered so a signature cannot authorize different
/// content, and the timestamp and nonce bound how long a captured signature
/// stays useful. Every field is length-prefixed with a big-endian `u32`, so no
/// two distinct requests share a preimage by running one field into the next.
pub fn request_digest(
    grant: &CredentialGrant,
    query: &str,
    timestamp: u64,
    nonce: &[u8],
    body_hash: &[u8; 32],
) -> [u8; 32] {
    let mut preimage = Vec::new();
    preimage.extend_from_slice(REQUEST_DIGEST_LABEL);
    push_field(&mut preimage, grant.method.as_bytes());
    push_field(&mut preimage, grant.domain.as_bytes());
    push_field(&mut preimage, grant.path.as_bytes());
    push_field(&mut preimage, query.as_bytes());
    preimage.extend_from_slice(&timestamp.to_be_bytes());
    push_field(&mut preimage, nonce);
    preimage.extend_from_slice(body_hash);
    blake2b256_keyed(&preimage, &[])
}

/// Hash of a request body, for [`request_digest`]. An empty body hashes like
/// any other, so a body cannot be added or removed without changing the digest.
pub fn body_hash(body: &[u8]) -> [u8; 32] {
    blake2b256_keyed(body, &[])
}

/// The signing key for one product calling one endpoint.
///
/// Derived from the session's pre-hashed root entropy source, which both a
/// signing host and a paired host hold, so either derives the same key locally
/// without consulting the other. Unreachable through `host_derive_entropy`: see
/// [`CREDENTIAL_DOMAIN_SEPARATOR`].
pub fn credential_keypair(
    root_entropy_source: &[u8; 32],
    product_id: &str,
    grant: &CredentialGrant,
) -> Keypair {
    let product_id_hash = blake2b256_keyed(product_id.as_bytes(), CREDENTIAL_DOMAIN_SEPARATOR);
    let per_product = blake2b256_keyed(root_entropy_source, &product_id_hash);
    let seed = blake2b256_keyed(&per_product, &grant.digest());
    MiniSecretKey::from_bytes(&seed)
        .expect("blake2b256 yields 32 bytes, which is a valid MiniSecretKey; qed")
        .expand_to_keypair(ExpansionMode::Ed25519)
}

/// Sign a request digest under a credential key.
pub fn sign_request(keypair: &Keypair, digest: &[u8; 32]) -> [u8; 64] {
    keypair
        .secret
        .sign_simple(SR25519_SIGNING_CONTEXT, digest, &keypair.public)
        .to_bytes()
}

/// Drop every header the host reserves, so only the host's own identity
/// reaches the endpoint.
pub fn strip_reserved_headers(headers: &mut Vec<(String, String)>) {
    headers.retain(|(name, _)| !name.to_ascii_lowercase().starts_with(HEADER_PREFIX));
}

/// Append a byte string to a preimage, length-prefixed.
fn push_field(preimage: &mut Vec<u8>, field: &[u8]) {
    let len = u32::try_from(field.len()).unwrap_or(u32::MAX);
    preimage.extend_from_slice(&len.to_be_bytes());
    preimage.extend_from_slice(field);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_logic::entropy::derive_product_entropy_from_source;

    const SOURCE: [u8; 32] = [0x11; 32];

    fn grant() -> CredentialGrant {
        CredentialGrant::new("onramp.example.com", "/session", "POST").expect("canonical triple")
    }

    #[test]
    fn a_request_resolves_to_its_grant_and_query() {
        let (grant, query) = CredentialGrant::from_request(
            "post",
            "https://Onramp.Example.com/session?currency=EUR&amount=10",
        )
        .expect("covered request");

        assert_eq!(grant.domain, "onramp.example.com", "domain canonicalizes");
        assert_eq!(grant.method, "POST", "method canonicalizes");
        assert_eq!(grant.path, "/session", "path is verbatim");
        assert_eq!(query, "currency=EUR&amount=10", "query is kept, not granted");
    }

    #[test]
    fn a_grant_covers_https_only_and_takes_no_wildcards() {
        assert_eq!(
            CredentialGrant::from_request("GET", "http://onramp.example.com/session"),
            Err(CredentialError::NotHttps),
        );
        assert_eq!(
            CredentialGrant::from_request("GET", "onramp.example.com/session"),
            Err(CredentialError::InvalidUrl),
            "a scheme-less URL is not an endpoint"
        );
        assert_eq!(
            CredentialGrant::new("*.example.com", "/session", "GET"),
            Err(CredentialError::Wildcard),
        );
        assert_eq!(
            CredentialGrant::new("onramp.example.com", "/session/*", "GET"),
            Err(CredentialError::Wildcard),
        );
    }

    /// Literal vectors. A backend verifier has to reproduce these bytes
    /// exactly, so a round trip through this module would not be a test:
    /// it would pass just as well if the preimage moved.
    #[test]
    fn request_digest_is_pinned() {
        let digest = request_digest(&grant(), "currency=EUR", 1_760_000_000, &[0xAA; 16], &[0; 32]);
        assert_eq!(
            hex::encode(digest),
            "02c47cb7da696d605d9904c8caa93ccad52158b12892a0dd6641579a314b75a9",
        );

        assert_eq!(
            hex::encode(grant().digest()),
            "e35da854a70cf9d44421ab50adbb1fd22cf14184304f210ca9f003a04f0ab3b1",
        );
    }

    #[test]
    fn every_signed_field_changes_the_digest() {
        let base = request_digest(&grant(), "a=1", 100, b"nonce", &body_hash(b"body"));
        let variants = [
            (
                "query",
                request_digest(&grant(), "a=2", 100, b"nonce", &body_hash(b"body")),
            ),
            (
                "timestamp",
                request_digest(&grant(), "a=1", 101, b"nonce", &body_hash(b"body")),
            ),
            (
                "nonce",
                request_digest(&grant(), "a=1", 100, b"nonce2", &body_hash(b"body")),
            ),
            (
                "body",
                request_digest(&grant(), "a=1", 100, b"nonce", &body_hash(b"body2")),
            ),
            (
                "method",
                request_digest(
                    &CredentialGrant::new("onramp.example.com", "/session", "GET").unwrap(),
                    "a=1",
                    100,
                    b"nonce",
                    &body_hash(b"body"),
                ),
            ),
        ];
        for (field, variant) in variants {
            assert_ne!(base, variant, "{field} must be covered by the signature");
        }
    }

    /// The length prefixes exist so no two distinct requests share a preimage
    /// by running one field into the next.
    #[test]
    fn adjacent_fields_cannot_be_confused() {
        let split = CredentialGrant::new("onramp.example.com", "/session", "POST").unwrap();
        let joined = CredentialGrant::new("onramp.example.com/session", "", "POST").unwrap();
        assert_ne!(split.digest(), joined.digest());
    }

    #[test]
    fn a_key_is_stable_per_endpoint_and_unrelated_across_them() {
        let other_path = CredentialGrant::new("onramp.example.com", "/quote", "POST").unwrap();
        let other_method = CredentialGrant::new("onramp.example.com", "/session", "GET").unwrap();
        let other_domain = CredentialGrant::new("other.example.com", "/session", "POST").unwrap();

        let key = |product: &str, g: &CredentialGrant| {
            credential_keypair(&SOURCE, product, g).public.to_bytes()
        };

        assert_eq!(
            key("meld.dot", &grant()),
            key("meld.dot", &grant()),
            "the same wallet, product and endpoint yields one key"
        );
        for (name, other) in [
            ("path", &other_path),
            ("method", &other_method),
            ("domain", &other_domain),
        ] {
            assert_ne!(
                key("meld.dot", &grant()),
                key("meld.dot", other),
                "a different {name} is a different endpoint"
            );
        }
        assert_ne!(
            key("meld.dot", &grant()),
            key("other.dot", &grant()),
            "a shared backend sees a different key per product"
        );
        assert_ne!(
            key("meld.dot", &grant()),
            credential_keypair(&[0x22; 32], "meld.dot", &grant())
                .public
                .to_bytes(),
            "a different wallet is a different caller"
        );
    }

    /// The security property the whole mechanism rests on: a product that can
    /// call `host_derive_entropy` with any key must not be able to reach the
    /// credential key for an endpoint it was never granted.
    #[test]
    fn a_product_cannot_derive_its_own_credential_keys() {
        let credential = credential_keypair(&SOURCE, "meld.dot", &grant())
            .secret
            .to_bytes();

        let reachable = [
            CREDENTIAL_DOMAIN_SEPARATOR.to_vec(),
            grant().digest().to_vec(),
            REQUEST_DIGEST_LABEL.to_vec(),
            b"meld.dot".to_vec(),
        ];
        for key in reachable {
            let derived = derive_product_entropy_from_source(&SOURCE, "meld.dot", &key)
                .expect("key is 1..=32 bytes");
            assert_ne!(
                credential[..32],
                derived[..],
                "product entropy must not reach the credential key tree"
            );
        }
    }

    #[test]
    fn a_signature_verifies_against_the_attached_key() {
        let keypair = credential_keypair(&SOURCE, "meld.dot", &grant());
        let digest = request_digest(&grant(), "", 1_760_000_000, b"nonce", &body_hash(b""));
        let signature = sign_request(&keypair, &digest);

        let parsed = schnorrkel::Signature::from_bytes(&signature).expect("signature parses");
        assert!(
            keypair
                .public
                .verify_simple(SR25519_SIGNING_CONTEXT, &digest, &parsed)
                .is_ok(),
            "a backend verifies with X-Polkadot-Key alone"
        );

        let other = request_digest(&grant(), "a=1", 1_760_000_000, b"nonce", &body_hash(b""));
        assert!(
            keypair
                .public
                .verify_simple(SR25519_SIGNING_CONTEXT, &other, &parsed)
                .is_err(),
            "a signature does not carry to a different request"
        );
    }

    #[test]
    fn caller_supplied_identity_headers_are_stripped() {
        let mut headers = vec![
            ("content-type".to_string(), "application/json".to_string()),
            ("X-Polkadot-Key".to_string(), "forged".to_string()),
            ("x-polkadot-signature".to_string(), "forged".to_string()),
            ("X-POLKADOT-Nonce".to_string(), "forged".to_string()),
            ("x-polkadot-anything".to_string(), "forged".to_string()),
        ];
        strip_reserved_headers(&mut headers);
        assert_eq!(
            headers,
            vec![("content-type".to_string(), "application/json".to_string())],
            "the whole reserved prefix goes, in any casing"
        );
    }
}
