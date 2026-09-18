//! `pallet-scarcity` reads: storage keys hand-built with the hashers the
//! pallet declares, values decoded against the connected chain's type registry.
//!
//! `NftsByOwner` and `Locked` are `Blake2_128Concat` maps; `Instances` and
//! both `ItemDefs` keys are `Twox64Concat`. The offline test below pins those
//! against the Asset Hub metadata fixture, the way the PGAS reader pins
//! `RingRoots`, so a runtime that changes a hasher fails a test instead of
//! reading empty slots.

use parity_scale_codec::{Decode, Encode};
use scale_decode::DecodeAsType;
use sp_crypto_hashing::{blake2_128, twox_64, twox_128};

use crate::runtime::statement_allowance::StatementAllowanceError;
use crate::runtime::statement_allowance::extension::Metadata;
use crate::runtime::statement_allowance::rpc::RpcClient;

/// The pallet's name in metadata.
pub(crate) const PALLET: &str = "Scarcity";

/// `Scarcity.NftsByOwner[purse]`: the one item a purse key holds.
#[derive(Debug, Clone, PartialEq, Eq, DecodeAsType)]
pub(crate) struct Nft {
    /// Globally unique instance id.
    pub instance: u64,
    /// Collection of the item definition.
    pub collection: u32,
    /// Item definition within the collection.
    pub item: u32,
    /// Unix seconds at mint.
    pub minted_at: u64,
    /// Unix seconds of the last move.
    pub last_moved: u64,
    /// Ownership-state revision; every move increments it.
    pub state_nonce: u64,
}

/// `Scarcity.Locked[purse]`: the backoff lock after a failed dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, DecodeAsType)]
pub(crate) struct LockInfo {
    /// Consecutive failed dispatches.
    pub retries: u8,
    /// Unix seconds when the lock lifts.
    pub until: u64,
}

/// Whether an item definition lets holders move its instances.
#[derive(Debug, Clone, Copy, PartialEq, Eq, DecodeAsType)]
pub(crate) enum Transferability {
    /// Holders may transfer.
    Transferable,
    /// Bound to the purse key it was minted into.
    Soulbound,
}

/// The fields of `Scarcity.ItemDefs` this reader needs.
#[derive(Debug, Clone, PartialEq, Eq, DecodeAsType)]
struct ItemDefinition {
    transferability: Transferability,
}

/// Failure reading the pallet.
#[derive(Debug, derive_more::Display)]
pub(crate) enum ChainError {
    /// The connected chain's metadata declares no such Scarcity storage entry.
    #[display("Scarcity.{entry} is not in the chain's metadata")]
    EntryMissing {
        /// Storage entry name.
        entry: &'static str,
    },
    /// A value did not decode against the chain's type registry.
    #[display("Scarcity.{entry}: {reason}")]
    Decode {
        /// Storage entry name.
        entry: &'static str,
        /// Decoder's reason.
        reason: String,
    },
    /// The RPC read failed.
    #[display("{_0}")]
    Rpc(StatementAllowanceError),
}

impl From<StatementAllowanceError> for ChainError {
    fn from(err: StatementAllowanceError) -> Self {
        Self::Rpc(err)
    }
}

fn entry_prefix(entry: &str) -> Vec<u8> {
    [twox_128(PALLET.as_bytes()), twox_128(entry.as_bytes())].concat()
}

fn blake2_128_concat(key: &[u8]) -> Vec<u8> {
    [blake2_128(key).as_slice(), key].concat()
}

fn twox_64_concat(key: &[u8]) -> Vec<u8> {
    [twox_64(key).as_slice(), key].concat()
}

/// The storage key of `NftsByOwner[owner]`.
pub(crate) fn nfts_by_owner_key(owner: &[u8; 32]) -> Vec<u8> {
    [entry_prefix("NftsByOwner"), blake2_128_concat(owner)].concat()
}

/// The storage key of `Locked[owner]`.
fn locked_key(owner: &[u8; 32]) -> Vec<u8> {
    [entry_prefix("Locked"), blake2_128_concat(owner)].concat()
}

/// The storage key of `Instances[instance]`.
fn instances_key(instance: u64) -> Vec<u8> {
    [
        entry_prefix("Instances"),
        twox_64_concat(&instance.encode()),
    ]
    .concat()
}

/// The storage key of `ItemDefs[collection][item]`.
fn item_defs_key(collection: u32, item: u32) -> Vec<u8> {
    [
        entry_prefix("ItemDefs"),
        twox_64_concat(&collection.encode()),
        twox_64_concat(&item.encode()),
    ]
    .concat()
}

fn decode_value<T: DecodeAsType>(
    metadata: &Metadata,
    entry: &'static str,
    bytes: &[u8],
) -> Result<T, ChainError> {
    let value_type = metadata
        .storage_value_type(PALLET, entry)
        .ok_or(ChainError::EntryMissing { entry })?;
    let mut input = bytes;
    T::decode_as_type(&mut input, value_type, metadata.registry()).map_err(|err| {
        ChainError::Decode {
            entry,
            reason: err.to_string(),
        }
    })
}

/// The item each purse key in `owners` holds, in order, `None` for an empty
/// key. One `state_queryStorageAt` round trip for the whole set.
pub(crate) async fn read_nfts(
    rpc: &RpcClient,
    metadata: &Metadata,
    owners: &[[u8; 32]],
) -> Result<Vec<Option<Nft>>, ChainError> {
    let keys: Vec<Vec<u8>> = owners.iter().map(nfts_by_owner_key).collect();
    rpc.get_storage_many(&keys)
        .await?
        .into_iter()
        .map(|value| {
            value
                .map(|bytes| decode_value::<Nft>(metadata, "NftsByOwner", &bytes))
                .transpose()
        })
        .collect()
}

/// The item `owner` holds at block `at` (or the best block), if any.
pub(crate) async fn read_nft(
    rpc: &RpcClient,
    metadata: &Metadata,
    owner: &[u8; 32],
    at: Option<&str>,
) -> Result<Option<Nft>, ChainError> {
    let key = nfts_by_owner_key(owner);
    let value = match at {
        Some(at) => rpc.get_storage_at(&key, at).await?,
        None => rpc.get_storage(&key).await?,
    };
    value
        .map(|bytes| decode_value::<Nft>(metadata, "NftsByOwner", &bytes))
        .transpose()
}

/// The purse key holding `instance` at block `at` (or the best block), if the
/// instance exists.
pub(crate) async fn read_instance_owner(
    rpc: &RpcClient,
    instance: u64,
    at: Option<&str>,
) -> Result<Option<[u8; 32]>, ChainError> {
    let key = instances_key(instance);
    let value = match at {
        Some(at) => rpc.get_storage_at(&key, at).await?,
        None => rpc.get_storage(&key).await?,
    };
    value
        .map(|bytes| {
            // `AccountId32` is 32 raw bytes on the wire.
            <[u8; 32]>::decode(&mut bytes.as_slice()).map_err(|err| ChainError::Decode {
                entry: "Instances",
                reason: err.to_string(),
            })
        })
        .transpose()
}

/// The failure lock on `owner`, if one is recorded.
pub(crate) async fn read_lock(
    rpc: &RpcClient,
    metadata: &Metadata,
    owner: &[u8; 32],
) -> Result<Option<LockInfo>, ChainError> {
    rpc.get_storage(&locked_key(owner))
        .await?
        .map(|bytes| decode_value::<LockInfo>(metadata, "Locked", &bytes))
        .transpose()
}

/// Whether holders may move instances of `(collection, item)`. `None` when the
/// item definition no longer exists.
pub(crate) async fn read_transferability(
    rpc: &RpcClient,
    metadata: &Metadata,
    collection: u32,
    item: u32,
) -> Result<Option<Transferability>, ChainError> {
    rpc.get_storage(&item_defs_key(collection, item))
        .await?
        .map(|bytes| {
            decode_value::<ItemDefinition>(metadata, "ItemDefs", &bytes)
                .map(|definition| definition.transferability)
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use frame_metadata::v14::{StorageEntryType, StorageHasher};
    use frame_metadata::{RuntimeMetadata, RuntimeMetadataPrefixed};

    use super::*;
    use crate::runtime::statement_allowance::test_fixtures;

    const ASSET_HUB_METADATA: &[u8] =
        include_bytes!("../../../tests/fixtures/paseo-next-asset-hub-metadata.scale");

    /// A hand-encoded `Nft` decodes against the fixture's `NftsByOwner` value
    /// type, proving the field order and widths this reader assumes.
    #[test]
    fn nft_decodes_against_asset_hub_metadata() {
        let metadata = test_fixtures::asset_hub();
        let mut bytes = Vec::new();
        bytes.extend(34u64.encode());
        bytes.extend(7u32.encode());
        bytes.extend(2u32.encode());
        bytes.extend(1_700_000_000u64.encode());
        bytes.extend(1_700_000_600u64.encode());
        bytes.extend(3u64.encode());
        let nft: Nft = decode_value(metadata, "NftsByOwner", &bytes).unwrap();
        assert_eq!(
            nft,
            Nft {
                instance: 34,
                collection: 7,
                item: 2,
                minted_at: 1_700_000_000,
                last_moved: 1_700_000_600,
                state_nonce: 3,
            }
        );
        let lock: LockInfo =
            decode_value(metadata, "Locked", &[2u8, 0, 0, 0, 0, 0, 0, 0, 60]).unwrap();
        assert_eq!(
            lock,
            LockInfo {
                retries: 2,
                until: 60 << 56
            }
        );
    }

    /// Build a map key the way the fixture's own metadata says to, so the
    /// hand-built keys above are checked against what the chain declares.
    fn declared_key(entry: &str, components: &[&[u8]]) -> Vec<u8> {
        let RuntimeMetadata::V16(metadata) =
            RuntimeMetadataPrefixed::decode(&mut &ASSET_HUB_METADATA[..])
                .expect("the fixture decodes")
                .1
        else {
            panic!("the Asset Hub fixture is V16");
        };
        let pallet = metadata
            .pallets
            .iter()
            .find(|pallet| pallet.name == PALLET)
            .expect("the fixture declares the Scarcity pallet");
        let storage = pallet.storage.as_ref().expect("Scarcity has storage");
        let declared = storage
            .entries
            .iter()
            .find(|declared| declared.name == entry)
            .unwrap_or_else(|| panic!("Scarcity.{entry} is declared"));
        let StorageEntryType::Map { hashers, .. } = &declared.ty else {
            panic!("Scarcity.{entry} is a map");
        };
        assert_eq!(
            hashers.len(),
            components.len(),
            "Scarcity.{entry} key arity"
        );
        let mut key = entry_prefix(entry);
        for (hasher, component) in hashers.iter().zip(components) {
            key.extend(match hasher {
                StorageHasher::Blake2_128Concat => blake2_128_concat(component),
                StorageHasher::Twox64Concat => twox_64_concat(component),
                other => {
                    panic!("Scarcity.{entry} uses {other:?}, which this reader does not build")
                }
            });
        }
        key
    }

    /// Every key this reader builds matches the hashers Asset Hub declares.
    #[test]
    fn storage_keys_match_the_hashers_asset_hub_declares() {
        let owner = [0x42u8; 32];
        assert_eq!(
            nfts_by_owner_key(&owner),
            declared_key("NftsByOwner", &[&owner])
        );
        assert_eq!(locked_key(&owner), declared_key("Locked", &[&owner]));
        assert_eq!(
            instances_key(34),
            declared_key("Instances", &[&34u64.encode()])
        );
        assert_eq!(
            item_defs_key(7, 2),
            declared_key("ItemDefs", &[&7u32.encode(), &2u32.encode()])
        );
    }

    #[test]
    fn every_entry_this_reader_decodes_exists_in_asset_hub_metadata() {
        let metadata = test_fixtures::asset_hub();
        for entry in ["NftsByOwner", "Locked", "ItemDefs", "Instances"] {
            assert!(
                metadata.storage_value_type(PALLET, entry).is_some(),
                "Scarcity.{entry}"
            );
        }
    }
}
