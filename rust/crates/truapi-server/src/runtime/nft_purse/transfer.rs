//! Moving one item between purse keys: build, sign, broadcast, verify.
//!
//! A holder transfer is a V4 signed extrinsic from the purse key carrying
//! `AsScarcity(Some(AsNft { instance, state_nonce }))`. Asset Hub's
//! transaction-extension pipeline declares no `VerifyMultiSignature`, so the
//! purse key can only authorize through the V4 preamble signature. The
//! extension replaces the signed origin before the account checks, so the
//! purse needs no System account and pays no fee; the nonce is therefore
//! always zero. The era must end before the pallet's failure lock does, so the
//! transaction is mortal and short, anchored right before signing so a consent
//! wait never eats into it. Inclusion is not success: the pallet restores the
//! item on a failed dispatch, so ownership is re-read at the included block.

use parity_scale_codec::Encode;
use serde_json::{Value, json};
use truapi::latest::{NftPurseError, NftPurseTransferStatus, TxPayloadExtension};

use super::chain::{self, Nft};
use super::engine::{AssetHub, Error, NftPurses};
use super::store::TransferLogEntry;
use crate::host_logic::extrinsic::{Sr25519Signer, build_signed_extrinsic_v4};
use crate::host_logic::nft_purse::{NftPurseDerivationError, derive_purse_keypair};
use crate::runtime::statement_allowance::StatementAllowanceError;
use crate::runtime::statement_allowance::extension::{
    AS_SCARCITY, ChainState, Metadata, MetadataError,
};
use crate::runtime::statement_allowance::rpc::RpcClient;
use crate::runtime::statement_allowance::slot::read_chain_now_seconds;

/// Era length in blocks. Under the runtime's 60-second `LockPeriod` at
/// six-second blocks, so a failed transaction expires before the lock lifts
/// and every retry is a fresh signature.
pub(crate) const TRANSFER_ERA_BLOCKS: u64 = 8;

/// `Option::Some` discriminant of the `AsScarcity` extra.
const OPTION_SOME: u8 = 0x01;

/// Transaction extension that carries the era.
const CHECK_MORTALITY: &str = "CheckMortality";

/// Transaction mortality, the `CheckMortality` extension's `extra`.
///
/// Mirrors Substrate's `sp_runtime::generic::Era`. A mortal transaction is
/// valid for `period` blocks from its birth block and is bound to that block's
/// hash instead of genesis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Era {
    /// Validity window in blocks, a power of two in `[4, 65536]`.
    period: u64,
    /// Quantized offset of the birth block within the period.
    phase: u64,
    /// Hash of the birth block; the extension's implicit.
    birth_hash: [u8; 32],
}

impl Era {
    /// Substrate `Era::mortal(period, current)`: rounds `period` up to a power
    /// of two clamped to `[4, 65536]` and quantizes the phase the way the
    /// runtime decodes it. `birth_hash` must be the hash of `current_block`,
    /// which for periods up to 4096 blocks is the birth block itself.
    pub(crate) fn mortal(period: u64, current_block: u64, birth_hash: [u8; 32]) -> Self {
        let period = period
            .checked_next_power_of_two()
            .unwrap_or(1 << 16)
            .clamp(4, 1 << 16);
        let phase = current_block % period;
        let quantize_factor = (period >> 12).max(1);
        let phase = phase / quantize_factor * quantize_factor;
        Self {
            period,
            phase,
            birth_hash,
        }
    }

    /// SCALE `extra` bytes: the two-byte packed period and phase.
    fn encode_extra(&self) -> Vec<u8> {
        let quantize_factor = (self.period >> 12).max(1);
        let encoded = (self.period.trailing_zeros() - 1).clamp(1, 15) as u16
            | ((self.phase / quantize_factor) << 4) as u16;
        encoded.to_le_bytes().to_vec()
    }

    /// The extension's implicit: the birth block hash.
    fn implicit(&self) -> Vec<u8> {
        self.birth_hash.to_vec()
    }
}

/// Why a transfer did not move the item.
#[derive(Debug, derive_more::Display)]
pub(crate) enum TransferError {
    /// The purse does not hold the named instance.
    #[display("the purse does not hold instance {instance}")]
    NotHeld {
        /// Instance asked for.
        instance: u64,
    },
    /// The destination is the holding key itself.
    #[display("the destination is the holding key")]
    TransferToSelf,
    /// The destination already holds an item.
    #[display("the destination already holds an item")]
    AddressOccupied,
    /// The holding key is locked after a failed dispatch.
    #[display("the holding key is locked until {until}")]
    Locked {
        /// Unix seconds when the lock lifts.
        until: u64,
    },
    /// The item definition binds the instance to its key.
    #[display("the item is soulbound")]
    Soulbound,
    /// The item moved between the read and the signature.
    #[display("the item's state changed before the transaction was built")]
    StateMismatch,
    /// The chain refused or dropped the transaction.
    #[display("the transaction was rejected: {reason}")]
    Rejected {
        /// Node or pool reason.
        reason: String,
    },
    /// Engine failure.
    #[display("{_0}")]
    Engine(Error),
}

impl From<Error> for TransferError {
    fn from(err: Error) -> Self {
        Self::Engine(err)
    }
}
impl From<chain::ChainError> for TransferError {
    fn from(err: chain::ChainError) -> Self {
        Self::Engine(err.into())
    }
}
impl From<NftPurseDerivationError> for TransferError {
    fn from(err: NftPurseDerivationError) -> Self {
        Self::Engine(err.into())
    }
}
impl From<StatementAllowanceError> for TransferError {
    fn from(err: StatementAllowanceError) -> Self {
        Self::Engine(err.into())
    }
}

impl TransferError {
    /// The service's view of this failure.
    pub(crate) fn to_service_error(&self) -> NftPurseError {
        match self {
            Self::NotHeld { .. } => NftPurseError::NotFound,
            Self::AddressOccupied => NftPurseError::AddressOccupied,
            Self::Locked { until } => NftPurseError::Locked { until: *until },
            Self::Soulbound => NftPurseError::Soulbound,
            Self::StateMismatch => NftPurseError::StateMismatch,
            Self::Engine(err) => err.to_service_error(),
            Self::TransferToSelf | Self::Rejected { .. } => NftPurseError::Unknown {
                reason: self.to_string(),
            },
        }
    }
}

/// The best block's number and hash: the mortal era's anchor.
async fn best_block(rpc: &RpcClient) -> Result<(u32, [u8; 32]), Error> {
    let header = rpc.call("chain_getHeader", json!([])).await?;
    let number = header
        .get("number")
        .and_then(Value::as_str)
        .and_then(|hex| u32::from_str_radix(hex.trim_start_matches("0x"), 16).ok())
        .ok_or_else(|| Error::Unknown {
            reason: "chain_getHeader returned no block number".into(),
        })?;
    let hash = rpc.call("chain_getBlockHash", json!([number])).await?;
    let hash = hash
        .as_str()
        .and_then(|hex| hex::decode(hex.trim_start_matches("0x")).ok())
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or_else(|| Error::Unknown {
            reason: "chain_getBlockHash returned no hash".into(),
        })?;
    Ok((number, hash))
}

/// The `AsScarcity` extra: `Some(AsNft { instance, state_nonce })`, the
/// variant index taken from metadata.
fn as_scarcity_extra(
    metadata: &Metadata,
    instance: u64,
    state_nonce: u64,
) -> Result<Vec<u8>, StatementAllowanceError> {
    let variant = metadata.extension_info_variant_index(AS_SCARCITY, "AsNft")?;
    let mut extra = Vec::with_capacity(2 + 8 + 8);
    extra.push(OPTION_SOME);
    extra.push(variant);
    instance.encode_to(&mut extra);
    state_nonce.encode_to(&mut extra);
    Ok(extra)
}

/// `Scarcity.transfer(to)` call bytes.
pub(crate) fn transfer_call(
    metadata: &Metadata,
    to: &[u8; 32],
) -> Result<Vec<u8>, StatementAllowanceError> {
    let mut call = metadata.call_indices(chain::PALLET, "transfer")?.to_vec();
    to.encode_to(&mut call);
    Ok(call)
}

/// The signed extensions of a holder transfer, in metadata order, with
/// `CheckMortality` carrying `era` and `AsScarcity` naming the instance and
/// its state; every other extension keeps its default encoding.
pub(crate) fn transfer_extensions(
    metadata: &Metadata,
    state: &ChainState,
    era: &Era,
    instance: u64,
    state_nonce: u64,
) -> Result<Vec<TxPayloadExtension>, StatementAllowanceError> {
    if metadata.extension_index(AS_SCARCITY).is_none() {
        return Err(MetadataError::MissingExtension {
            identifier: AS_SCARCITY.to_string(),
        }
        .into());
    }
    let extra = as_scarcity_extra(metadata, instance, state_nonce)?;
    Ok(metadata
        .encode_signed_extensions(state)
        .into_iter()
        .zip(metadata.extension_ids())
        .map(|(encoded, id)| match id {
            CHECK_MORTALITY => TxPayloadExtension {
                id: id.to_string(),
                extra: era.encode_extra(),
                additional_signed: era.implicit(),
            },
            AS_SCARCITY => TxPayloadExtension {
                id: id.to_string(),
                extra: extra.clone(),
                additional_signed: encoded.additional_signed,
            },
            _ => TxPayloadExtension {
                id: id.to_string(),
                extra: encoded.extra,
                additional_signed: encoded.additional_signed,
            },
        })
        .collect())
}

/// What the chain says about a logged transfer at a finalized block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Resolution {
    /// The destination holds the instance: the transfer landed.
    Landed,
    /// The source still holds it and the era has passed: it will never land.
    Expired,
    /// The source still holds it and the era is open: keep waiting.
    Pending,
    /// Neither key holds it: a force move or burn intervened; nothing to
    /// recover.
    Gone,
}

/// Decide a logged transfer from the instance's owner at a finalized block.
pub(crate) fn resolve(
    entry: &TransferLogEntry,
    owner_now: Option<&[u8; 32]>,
    finalized_number: u32,
) -> Resolution {
    match owner_now {
        Some(owner) if owner == &entry.to => Resolution::Landed,
        Some(owner) if owner == &entry.from_address => {
            if finalized_number >= entry.birth_block.saturating_add(entry.period) {
                Resolution::Expired
            } else {
                Resolution::Pending
            }
        }
        _ => Resolution::Gone,
    }
}

/// What to move where.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TransferSpec<'a> {
    /// Purse the item leaves.
    pub from_product_id: &'a str,
    /// Instance to move.
    pub instance: u64,
    /// Destination purse key.
    pub to: [u8; 32],
}

/// The transfer, from validation to verified ownership. `progress` receives
/// `Started` after the signed transaction is broadcast and `InBlock` when it
/// lands; the terminal `Landed` or `Failed` is the return value's job.
pub(crate) async fn execute(
    purses: &NftPurses,
    hub: &AssetHub,
    entropy: &[u8],
    root: [u8; 32],
    spec: TransferSpec<'_>,
    progress: &(dyn Fn(NftPurseTransferStatus) + Send + Sync),
) -> Result<[u8; 32], TransferError> {
    let TransferSpec {
        from_product_id,
        instance,
        to,
    } = spec;
    let metadata = &hub.context.metadata;
    let held = purses
        .scan_purse_with(hub, entropy, root, from_product_id)
        .await?;
    let item = held
        .into_iter()
        .find(|item| item.nft.instance == instance)
        .ok_or(TransferError::NotHeld { instance })?;
    if item.address == to {
        return Err(TransferError::TransferToSelf);
    }
    validate_destination_and_lock(&hub.rpc, metadata, &item.address, &to).await?;
    match chain::read_transferability(&hub.rpc, metadata, item.nft.collection, item.nft.item)
        .await?
    {
        Some(chain::Transferability::Transferable) => {}
        _ => return Err(TransferError::Soulbound),
    }
    // The signature binds the state the pool will check, so read it last.
    let fresh: Nft = chain::read_nft(&hub.rpc, metadata, &item.address, None)
        .await?
        .ok_or(TransferError::StateMismatch)?;
    if fresh.instance != instance {
        return Err(TransferError::StateMismatch);
    }

    let keypair = derive_purse_keypair(entropy, from_product_id, item.index)?;
    let signer = Sr25519Signer::from_keypair(&keypair);
    let (era_block_number, era_block_hash) = best_block(&hub.rpc).await?;
    let era = Era::mortal(
        TRANSFER_ERA_BLOCKS,
        u64::from(era_block_number),
        era_block_hash,
    );
    let extensions = transfer_extensions(
        metadata,
        &hub.context.state,
        &era,
        instance,
        fresh.state_nonce,
    )?;
    let call = transfer_call(metadata, &to)?;
    let extrinsic = build_signed_extrinsic_v4(&signer, &call, &extensions);

    let log_id = purses
        .store()
        .log_append(
            root,
            TransferLogEntry {
                id: 0,
                from_product_id: from_product_id.to_string(),
                from_index: item.index,
                from_address: item.address,
                instance,
                to,
                state_nonce: fresh.state_nonce,
                birth_block: era_block_number,
                period: TRANSFER_ERA_BLOCKS as u32,
            },
        )
        .await
        .map_err(Error::from)?;

    progress(NftPurseTransferStatus::Started);
    let block = match hub.rpc.submit_and_watch(&extrinsic).await {
        Ok(block) => block,
        Err(err) => {
            // Never included, so nothing to recover.
            let _ = purses.store().log_remove(root, log_id).await;
            return Err(TransferError::Rejected {
                reason: err.to_string(),
            });
        }
    };
    let block_hash = hex::decode(block.trim_start_matches("0x"))
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .unwrap_or([0; 32]);
    progress(NftPurseTransferStatus::InBlock { block: block_hash });

    let owner = chain::read_instance_owner(&hub.rpc, instance, Some(&block)).await?;
    let _ = purses.store().log_remove(root, log_id).await;
    match owner {
        Some(owner) if owner == to => Ok(block_hash),
        Some(owner) if owner == item.address => {
            let until = chain::read_lock(&hub.rpc, metadata, &item.address)
                .await?
                .map_or(0, |lock| lock.until);
            Err(TransferError::Locked { until })
        }
        other => Err(TransferError::Rejected {
            reason: format!(
                "included in {block} but the instance is now held by {:?}",
                other.map(hex::encode)
            ),
        }),
    }
}

async fn validate_destination_and_lock(
    rpc: &RpcClient,
    metadata: &Metadata,
    source: &[u8; 32],
    to: &[u8; 32],
) -> Result<(), TransferError> {
    if chain::read_nft(rpc, metadata, to, None).await?.is_some() {
        return Err(TransferError::AddressOccupied);
    }
    if let Some(lock) = chain::read_lock(rpc, metadata, source).await? {
        let now = read_chain_now_seconds(rpc).await?;
        if lock.until > now {
            return Err(TransferError::Locked { until: lock.until });
        }
    }
    Ok(())
}

/// Resolve every logged transfer against the finalized head and drop the ones
/// the chain has settled. Runs before a purse scan so a restart never reports
/// an item both moved and held. Every entry carries its holding key, so no
/// derivation is needed.
pub(crate) async fn recover(
    purses: &NftPurses,
    hub: &AssetHub,
    root: [u8; 32],
) -> Result<(), TransferError> {
    let entries = purses
        .store()
        .log_entries(root)
        .await
        .map_err(Error::from)?;
    if entries.is_empty() {
        return Ok(());
    }
    let finalized = hub.rpc.finalized_head().await?;
    let finalized_number = block_number_of(&hub.rpc, &finalized).await?;
    for entry in entries {
        let owner = chain::read_instance_owner(&hub.rpc, entry.instance, Some(&finalized)).await?;
        match resolve(&entry, owner.as_ref(), finalized_number) {
            Resolution::Pending => {}
            Resolution::Landed | Resolution::Expired | Resolution::Gone => {
                purses
                    .store()
                    .log_remove(root, entry.id)
                    .await
                    .map_err(Error::from)?;
            }
        }
    }
    Ok(())
}

async fn block_number_of(rpc: &RpcClient, hash: &str) -> Result<u32, TransferError> {
    let header = rpc.call("chain_getHeader", json!([hash])).await?;
    header
        .get("number")
        .and_then(Value::as_str)
        .and_then(|hex| u32::from_str_radix(hex.trim_start_matches("0x"), 16).ok())
        .ok_or_else(|| {
            Error::Unknown {
                reason: "chain_getHeader returned no block number".into(),
            }
            .into()
        })
}

#[cfg(test)]
mod tests {
    use parity_scale_codec::{Compact, Decode};

    use super::*;
    use crate::host_logic::product_account::SR25519_SIGNING_CONTEXT;
    use crate::runtime::statement_allowance::test_fixtures;

    const ENTROPY: [u8; 16] = [0xAB; 16];

    fn state() -> ChainState {
        ChainState {
            spec_version: 3_000_000,
            transaction_version: 1,
            genesis_hash: [0x11; 32],
            nonce: 0,
            restrict_origins: false,
        }
    }

    /// Substrate `generic::Era` golden vectors: `mortal(64, 42)` and the
    /// quantized long period from `sp_runtime`'s own tests.
    #[test]
    fn era_encodes_like_substrate() {
        let short = Era::mortal(64, 42, [0x11; 32]);
        assert_eq!(
            short,
            Era {
                period: 64,
                phase: 42,
                birth_hash: [0x11; 32]
            }
        );
        assert_eq!(short.encode_extra(), vec![5 + 42 % 16 * 16, 42 / 16]);
        assert_eq!(short.implicit(), vec![0x11; 32]);
        let long = Era::mortal(32768, 20000, [0; 32]);
        assert_eq!(
            long.encode_extra(),
            vec![(14 + 2500 % 16 * 16) as u8, (2500 / 16) as u8]
        );
        // Periods round up to a power of two and clamp to [4, 65536].
        assert_eq!(Era::mortal(6, 0, [0; 32]).period, 8);
        assert_eq!(Era::mortal(1, 0, [0; 32]).period, 4);
        assert_eq!(Era::mortal(1 << 20, 0, [0; 32]).period, 65536);
        // The transfer era is short enough that the phase is never quantized.
        assert_eq!(
            Era::mortal(TRANSFER_ERA_BLOCKS, 1005, [0; 32]).phase,
            1005 % 8
        );
    }

    /// Asset Hub declares the pallet's extension with its `AsNft` variant and
    /// no `VerifyMultiSignature`, which is why the transfer is a V4 signed
    /// extrinsic: the purse key has nowhere else to put its signature.
    #[test]
    fn asset_hub_declares_as_scarcity_and_no_verify_multi_signature() {
        let metadata = test_fixtures::asset_hub();
        assert!(metadata.extension_index(AS_SCARCITY).is_some());
        assert!(
            metadata
                .extension_info_variant_index(AS_SCARCITY, "AsNft")
                .is_ok()
        );
        assert!(
            metadata.extension_index("VerifyMultiSignature").is_none(),
            "Asset Hub gained VerifyMultiSignature; the transfer can move to V5 General"
        );
    }

    /// The extensions keep metadata order, carry the era where genesis used to
    /// be, and name the instance and state in `AsScarcity`; nothing else
    /// changes.
    #[test]
    fn transfer_extensions_replace_only_mortality_and_as_scarcity() {
        let metadata = test_fixtures::asset_hub();
        let state = state();
        let era = Era::mortal(TRANSFER_ERA_BLOCKS, 1000, [0x22; 32]);
        let extensions = transfer_extensions(metadata, &state, &era, 34, 3).unwrap();
        let defaults = metadata.encode_signed_extensions(&state);
        let ids = metadata.extension_ids();
        assert_eq!(extensions.len(), ids.len());
        for (position, extension) in extensions.iter().enumerate() {
            assert_eq!(extension.id, ids[position]);
            match extension.id.as_str() {
                CHECK_MORTALITY => {
                    assert_eq!(extension.extra, era.encode_extra());
                    assert_eq!(extension.additional_signed, vec![0x22; 32]);
                }
                AS_SCARCITY => {
                    let variant = metadata
                        .extension_info_variant_index(AS_SCARCITY, "AsNft")
                        .unwrap();
                    assert_eq!(
                        extension.extra,
                        [vec![0x01, variant], 34u64.encode(), 3u64.encode()].concat()
                    );
                    assert_eq!(
                        extension.additional_signed,
                        defaults[position].additional_signed
                    );
                }
                _ => {
                    assert_eq!(
                        extension.extra, defaults[position].extra,
                        "{}",
                        extension.id
                    );
                    assert_eq!(
                        extension.additional_signed, defaults[position].additional_signed,
                        "{}",
                        extension.id
                    );
                }
            }
        }
    }

    /// The signed V4 body carries the purse key as signer, the metadata-order
    /// extras with the era and `AsScarcity` replaced, and the call; the
    /// signature verifies over `call ‖ extras ‖ implicits` with the purse key.
    #[test]
    fn transfer_extrinsic_has_the_pallet_shape() {
        let metadata = test_fixtures::asset_hub();
        let state = state();
        let era = Era::mortal(TRANSFER_ERA_BLOCKS, 1000, [0x22; 32]);
        let keypair = derive_purse_keypair(&ENTROPY, "cardclash.dot", 1).unwrap();
        let to = [0x33u8; 32];
        let extensions = transfer_extensions(metadata, &state, &era, 34, 3).unwrap();
        let call = transfer_call(metadata, &to).unwrap();
        let extrinsic =
            build_signed_extrinsic_v4(&Sr25519Signer::from_keypair(&keypair), &call, &extensions);

        let mut input = extrinsic.as_slice();
        let len = Compact::<u32>::decode(&mut input).unwrap().0 as usize;
        assert_eq!(input.len(), len);
        assert_eq!(input[0], 0x84, "signed v4");
        assert_eq!(input[1], 0x00, "MultiAddress::Id");
        assert_eq!(&input[2..34], &keypair.public.to_bytes());
        assert_eq!(input[34], 0x01, "MultiSignature::Sr25519");
        let signature = schnorrkel::Signature::from_bytes(&input[35..99]).unwrap();
        let rest = &input[99..];

        let extras: Vec<u8> = extensions.iter().flat_map(|e| e.extra.clone()).collect();
        let implicits: Vec<u8> = extensions
            .iter()
            .flat_map(|e| e.additional_signed.clone())
            .collect();
        assert_eq!(rest, [extras.clone(), call.clone()].concat());
        assert!(
            implicits.windows(32).any(|w| w == [0x22; 32]),
            "the era anchors to the birth block, not genesis"
        );

        let payload = [call, extras, implicits].concat();
        let signed = if payload.len() > 256 {
            sp_crypto_hashing::blake2_256(&payload).to_vec()
        } else {
            payload
        };
        keypair
            .public
            .verify_simple(SR25519_SIGNING_CONTEXT, &signed, &signature)
            .expect("the purse key signed the v4 payload");
    }

    #[test]
    fn logged_transfers_resolve_from_the_finalized_owner() {
        let source = [1u8; 32];
        let entry = TransferLogEntry {
            id: 0,
            from_product_id: "cardclash.dot".into(),
            from_index: 0,
            from_address: source,
            instance: 34,
            to: [2; 32],
            state_nonce: 0,
            birth_block: 100,
            period: 8,
        };
        assert_eq!(resolve(&entry, Some(&[2; 32]), 101), Resolution::Landed);
        assert_eq!(resolve(&entry, Some(&source), 105), Resolution::Pending);
        assert_eq!(resolve(&entry, Some(&source), 108), Resolution::Expired);
        assert_eq!(resolve(&entry, Some(&[7; 32]), 101), Resolution::Gone);
        assert_eq!(resolve(&entry, None, 101), Resolution::Gone);
    }
}
