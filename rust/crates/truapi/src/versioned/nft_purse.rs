//! Versioned wrappers for [`NftPurse`](crate::api::NftPurse) methods.

use crate::v01;

truapi_macros::versioned_type! {
    pub enum HostNftPurseListRequest { V1 => v01::HostNftPurseListRequest }
    pub enum HostNftPurseListResponse { V1 => v01::HostNftPurseListResponse }
    pub enum HostNftPurseListError { V1 => v01::NftPurseError }
    pub enum HostNftPurseListSubscribeRequest { V1 => v01::HostNftPurseListSubscribeRequest }
    pub enum HostNftPurseListSubscribeItem { V1 => v01::HostNftPurseListSubscribeItem }
    pub enum HostNftPurseListSubscribeError { V1 => v01::NftPurseError }
    pub enum HostNftPurseRequestReceiveAddressRequest { V1 => v01::HostNftPurseRequestReceiveAddressRequest }
    pub enum HostNftPurseRequestReceiveAddressResponse { V1 => v01::HostNftPurseRequestReceiveAddressResponse }
    pub enum HostNftPurseRequestReceiveAddressError { V1 => v01::NftPurseError }
    pub enum HostNftPurseTransferRequest { V1 => v01::HostNftPurseTransferRequest }
    pub enum HostNftPurseTransferItem { V1 => v01::NftPurseTransferStatus }
    pub enum HostNftPurseTransferError { V1 => v01::NftPurseError }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parity_scale_codec::Encode;

    /// `NotConnected` is what a pairing host answers before it is paired, so
    /// its discriminant is what a product waits on; pin it.
    #[test]
    fn not_connected_error_keeps_its_discriminant() {
        let error = HostNftPurseListError::V1(v01::NftPurseError::NotConnected);
        assert_eq!(hex::encode(error.encode()), "0008");
    }
}
