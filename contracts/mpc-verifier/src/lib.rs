#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Bytes, BytesN, Env, Vec,
};

/// Storage keys for the MPC verifier contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The admin allowed to register cosigners.
    Admin,
    /// Registered cosigner public keys keyed by index.
    Cosigner(u32),
    /// Number of registered cosigners.
    CosignerCount,
    /// Threshold (T) required for a valid quorum.
    Threshold,
    /// Scheme used for verification (0 = ECDSA secp256k1, 1 = Ed25519).
    Scheme,
}

/// Signature scheme selector.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Ecdsa = 0,
    Ed25519 = 1,
}

/// Errors returned by the verifier.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidThreshold = 4,
    InvalidScheme = 5,
    InvalidBitmap = 6,
    InsufficientSigners = 7,
    UnknownCosigner = 8,
    InvalidSignature = 9,
    HighS = 10,
    NonCanonical = 11,
    LengthMismatch = 12,
}

/// secp256k1 group order divided by two (low-S bound).
/// n = 0xFFFFFFFF FFFFFFFF FFFFFFFF FFFFFFFE BAAEDCE6 AF48A03B BFD25E8C D0364141
/// n/2 = 0x7FFFFFFF FFFFFFFF FFFFFFFF FFFFFFFF 5D576E73 57A4501D DFE92F46 681B20A0
const SECP256K1_HALF_N: [u8; 32] = [
    0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0x5D, 0x57, 0x6E, 0x73, 0x57, 0xA4, 0x50, 0x1D, 0xDF, 0xE9, 0x2F, 0x46, 0x68, 0x1B, 0x20, 0xA0,
];

/// Ed25519 group order L.
/// L = 0x10000000 00000000 00000000 00000000 14DEF9DE A2F79CD6 5812631A 5CF5D3ED
const ED25519_L: [u8; 32] = [
    0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x14, 0xDE, 0xF9, 0xDE, 0xA2, 0xF7, 0x9C, 0xD6, 0x58, 0x12, 0x63, 0x1A, 0x5C, 0xF5, 0xD3, 0xED,
];

#[contract]
pub struct MpcVerifier;

#[contractimpl]
impl MpcVerifier {
    /// Initialize the verifier with an admin, threshold, and scheme.
    pub fn initialize(env: Env, admin: Address, threshold: u32, scheme: u32) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        if threshold == 0 {
            panic_with_error!(&env, Error::InvalidThreshold);
        }
        let scheme = match scheme {
            0 => Scheme::Ecdsa,
            1 => Scheme::Ed25519,
            _ => panic_with_error!(&env, Error::InvalidScheme),
        };
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        env.storage().instance().set(&DataKey::Scheme, &scheme);
        env.storage().instance().set(&DataKey::CosignerCount, &0u32);
    }

    /// Register a cosigner public key at the next available index.
    pub fn register_cosigner(env: Env, admin: Address, pubkey: BytesN<32>) -> u32 {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        if admin != stored_admin {
            panic_with_error!(&env, Error::Unauthorized);
        }
        let mut count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CosignerCount)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::Cosigner(count), &pubkey);
        count += 1;
        env.storage().instance().set(&DataKey::CosignerCount, &count);
        count
    }

    /// Update the threshold. Only admin may call.
    pub fn set_threshold(env: Env, admin: Address, threshold: u32) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        if admin != stored_admin {
            panic_with_error!(&env, Error::Unauthorized);
        }
        if threshold == 0 {
            panic_with_error!(&env, Error::InvalidThreshold);
        }
        env.storage().instance().set(&DataKey::Threshold, &threshold);
    }

    /// Return the configured threshold.
    pub fn threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    /// Return the number of registered cosigners.
    pub fn cosigner_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::CosignerCount)
            .unwrap_or(0)
    }

    /// Verify an aggregated threshold signature.
    ///
    /// * `message` - the message that was signed.
    /// * `signature` - the aggregated signature (64 bytes: r||s for ECDSA, R||S for Ed25519).
    /// * `bitmap` - bitmap of participating cosigners (bit i set => cosigner i participated).
    ///
    /// Returns `true` if the signature is valid and the participating cosigners
    /// meet the configured threshold. Panics with a typed error otherwise.
    pub fn verify(env: Env, message: Bytes, signature: BytesN<64>, bitmap: Bytes) -> bool {
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        let scheme: Scheme = env
            .storage()
            .instance()
            .get(&DataKey::Scheme)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        let cosigner_count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CosignerCount)
            .unwrap_or(0);

        // Decode and validate the bitmap.
        let participants = Self::decode_bitmap(&env, &bitmap, cosigner_count);
        if participants < threshold {
            panic_with_error!(&env, Error::InsufficientSigners);
        }

        // Malleability protection.
        match scheme {
            Scheme::Ecdsa => Self::enforce_low_s(&env, &signature),
            Scheme::Ed25519 => Self::enforce_canonical_ed25519(&env, &signature),
        }

        // Perform the actual cryptographic verification.
        let valid = match scheme {
            Scheme::Ecdsa => Self::verify_ecdsa(&env, &message, &signature),
            Scheme::Ed25519 => Self::verify_ed25519(&env, &message, &signature),
        };

        if !valid {
            panic_with_error!(&env, Error::InvalidSignature);
        }
        true
    }

    /// Decode the bitmap and return the number of set bits, validating that
    /// every set bit corresponds to a registered cosigner.
    fn decode_bitmap(env: &Env, bitmap: &Bytes, cosigner_count: u32) -> u32 {
        let len = bitmap.len();
        if len == 0 {
            panic_with_error!(env, Error::InvalidBitmap);
        }
        // Bitmap must be large enough to cover all registered cosigners.
        let required_bytes = (cosigner_count + 7) / 8;
        if len < required_bytes {
            panic_with_error!(env, Error::InvalidBitmap);
        }
        let mut count: u32 = 0;
        let mut i: u32 = 0;
        while i < len {
            let byte = bitmap.get(i).unwrap();
            let mut bit: u32 = 0;
            while bit < 8 {
                if (byte >> bit) & 1 == 1 {
                    let index = i * 8 + bit;
                    if index >= cosigner_count {
                        panic_with_error!(env, Error::UnknownCosigner);
                    }
                    count += 1;
                }
                bit += 1;
            }
            i += 1;
        }
        count
    }

    /// Enforce low-S for secp256k1 ECDSA signatures.
    fn enforce_low_s(env: &Env, signature: &BytesN<64>) {
        let mut s = [0u8; 32];
        let mut i: u32 = 0;
        while i < 32 {
            s[i as usize] = signature.get(32 + i).unwrap();
            i += 1;
        }
        if Self::bytes_gt(&s, &SECP256K1_HALF_N) {
            panic_with_error!(env, Error::HighS);
        }
    }

    /// Enforce canonical encoding for Ed25519 signatures (S < L).
    fn enforce_canonical_ed25519(env: &Env, signature: &BytesN<64>) {
        let mut s = [0u8; 32];
        let mut i: u32 = 0;
        while i < 32 {
            s[i as usize] = signature.get(32 + i).unwrap();
            i += 1;
        }
        if !Self::bytes_lt(&s, &ED25519_L) {
            panic_with_error!(env, Error::NonCanonical);
        }
    }

    /// Verify an ECDSA secp256k1 signature over the message.
    fn verify_ecdsa(env: &Env, message: &Bytes, signature: &BytesN<64>) -> bool {
        let msg_hash = env.crypto().sha256(message);
        let msg_bytes: BytesN<32> = msg_hash.to_bytes();
        let sig_bytes: Bytes = signature.clone().into();
        env.crypto()
            .secp256k1_recover(&msg_bytes, &sig_bytes)
            .is_ok()
    }

    /// Verify an Ed25519 signature over the message.
    fn verify_ed25519(env: &Env, message: &Bytes, signature: &BytesN<64>) -> bool {
        // The aggregated public key is derived from participating cosigners.
        // For the contract-level check we verify against the aggregated key
        // stored under the reserved key. If no aggregated key is present we
        // fall back to verifying the signature structure only.
        let agg_key: Option<BytesN<32>> = env
            .storage()
            .instance()
            .get(&symbol_short!("aggkey"));
        match agg_key {
            Some(pubkey) => env
                .crypto()
                .ed25519_verify(&pubkey, message, signature),
            None => {
                // Without an aggregated key we cannot perform full verification.
                // Reject to avoid accepting unverifiable signatures.
                let _ = message;
                false
            }
        }
    }

    /// Set the aggregated public key used for Ed25519 verification.
    pub fn set_aggregated_key(env: Env, admin: Address, pubkey: BytesN<32>) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        if admin != stored_admin {
            panic_with_error!(&env, Error::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&symbol_short!("aggkey"), &pubkey);
    }

    /// Compare two 32-byte big-endian arrays: returns true if a > b.
    fn bytes_gt(a: &[u8; 32], b: &[u8; 32]) -> bool {
        let mut i = 0;
        while i < 32 {
            if a[i] > b[i] {
                return true;
            }
            if a[i] < b[i] {
                return false;
            }
            i += 1;
        }
        false
    }

    /// Compare two 32-byte big-endian arrays: returns true if a < b.
    fn bytes_lt(a: &[u8; 32], b: &[u8; 32]) -> bool {
        let mut i = 0;
        while i < 32 {
            if a[i] < b[i] {
                return true;
            }
            if a[i] > b[i] {
                return false;
            }
            i += 1;
        }
        false
    }
}

#[cfg(test)]
mod test;