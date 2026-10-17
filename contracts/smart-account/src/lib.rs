#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Env, Map, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidWeight = 3,
    InvalidThreshold = 4,
    InvalidAmount = 5,
    UnknownSigner = 6,
    DuplicateSigner = 7,
    ThresholdNotMet = 8,
    InsufficientBalance = 9,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Signers,
    Threshold,
}

#[contract]
pub struct SmartAccount;

#[contractimpl]
impl SmartAccount {
    /// Stores the weighted signer set. The threshold must be reachable by the
    /// combined weight of all signers so the account can never be bricked.
    pub fn init(env: Env, signers: Map<Address, u32>, threshold: u32) -> Result<(), Error> {
        let storage = env.storage().instance();
        if storage.has(&DataKey::Signers) {
            return Err(Error::AlreadyInitialized);
        }

        // Weights are summed in u64 so no combination of u32 weights can overflow.
        let mut total_weight: u64 = 0;
        for (_, weight) in signers.iter() {
            if weight == 0 {
                return Err(Error::InvalidWeight);
            }
            total_weight += weight as u64;
        }
        if threshold == 0 || total_weight < threshold as u64 {
            return Err(Error::InvalidThreshold);
        }

        storage.set(&DataKey::Signers, &signers);
        storage.set(&DataKey::Threshold, &threshold);
        Ok(())
    }

    /// Transfers `amount` of `token` out of the account once every approver has
    /// authorized the call and their combined weight meets the threshold.
    pub fn transfer(
        env: Env,
        approvers: Vec<Address>,
        token: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let storage = env.storage().instance();
        let signers: Map<Address, u32> = storage
            .get(&DataKey::Signers)
            .ok_or(Error::NotInitialized)?;
        let threshold: u32 = storage
            .get(&DataKey::Threshold)
            .ok_or(Error::NotInitialized)?;

        let mut seen: Map<Address, bool> = Map::new(&env);
        let mut approved_weight: u64 = 0;
        for approver in approvers.iter() {
            if seen.contains_key(approver.clone()) {
                return Err(Error::DuplicateSigner);
            }
            let weight = signers
                .get(approver.clone())
                .ok_or(Error::UnknownSigner)?;
            approver.require_auth();
            seen.set(approver, true);
            approved_weight += weight as u64;
        }
        if approved_weight < threshold as u64 {
            return Err(Error::ThresholdNotMet);
        }

        let client = token::Client::new(&env, &token);
        let account = env.current_contract_address();
        if client.balance(&account) < amount {
            return Err(Error::InsufficientBalance);
        }
        client.transfer(&account, &to, &amount);
        Ok(())
    }

    pub fn signers(env: Env) -> Map<Address, u32> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Map::new(&env))
    }

    pub fn threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(0)
    }
}
