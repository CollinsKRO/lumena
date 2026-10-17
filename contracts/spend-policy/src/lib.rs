Cargo.toml:

```toml
[package]
name = "spend-policy"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
soroban-sdk = { version = "20.0.0" }

[dev-dependencies]
soroban-sdk = { version = "20.0.0", features = ["testutils"] }
```

src/lib.rs:

```rust
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec,
};

/// Number of seconds in a rolling window (24 hours).
const WINDOW_SECONDS: u64 = 24 * 60 * 60;

/// Delay applied to master-key limit changes (24 hours).
const LIMIT_CHANGE_DELAY: u64 = 24 * 60 * 60;

/// Maximum number of spend entries kept per (asset, account) window.
const MAX_ENTRIES: u32 = 64;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    ExceedsAllowance = 4,
    InvalidAmount = 5,
    NoPendingLimit = 6,
    DelayNotElapsed = 7,
    TooManyEntries = 8,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpendEntry {
    pub timestamp: u64,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingLimit {
    pub limit: i128,
    pub effective_time: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Master,
    Limit(Address, Address),
    Pending(Address, Address),
    Spends(Address, Address),
}

#[contract]
pub struct SpendPolicyContract;

#[contractimpl]
impl SpendPolicyContract {
    /// Initialize the contract with the master key that can adjust limits.
    pub fn initialize(env: Env, master: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Master) {
            return Err(Error::AlreadyInitialized);
        }
        master.require_auth();
        env.storage().instance().set(&DataKey::Master, &master);
        Ok(())
    }

    /// Return the current master key.
    pub fn master(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Master)
            .ok_or(Error::NotInitialized)
    }

    /// Set the daily limit for (asset, account) immediately. Only the master
    /// key may call this. Intended for initial configuration.
    pub fn set_limit(
        env: Env,
        asset: Address,
        account: Address,
        limit: i128,
    ) -> Result<(), Error> {
        let master = Self::master(env.clone())?;
        master.require_auth();
        if limit < 0 {
            return Err(Error::InvalidAmount);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Limit(asset, account), &limit);
        Ok(())
    }

    /// Get the currently active daily limit for (asset, account).
    pub fn get_limit(env: Env, asset: Address, account: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Limit(asset, account))
            .unwrap_or(0)
    }

    /// Schedule a limit change that takes effect 24 hours from now.
    pub fn schedule_limit(
        env: Env,
        asset: Address,
        account: Address,
        limit: i128,
    ) -> Result<(), Error> {
        let master = Self::master(env.clone())?;
        master.require_auth();
        if limit < 0 {
            return Err(Error::InvalidAmount);
        }
        let effective_time = env.ledger().timestamp() + LIMIT_CHANGE_DELAY;
        let pending = PendingLimit {
            limit,
            effective_time,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Pending(asset, account), &pending);
        Ok(())
    }

    /// Get the pending limit change for (asset, account), if any.
    pub fn get_pending_limit(
        env: Env,
        asset: Address,
        account: Address,
    ) -> Option<PendingLimit> {
        env.storage()
            .persistent()
            .get(&DataKey::Pending(asset, account))
    }

    /// Apply a scheduled limit change once its 24-hour delay has elapsed.
    pub fn apply_pending_limit(
        env: Env,
        asset: Address,
        account: Address,
    ) -> Result<i128, Error> {
        let pending: PendingLimit = env
            .storage()
            .persistent()
            .get(&DataKey::Pending(asset, account))
            .ok_or(Error::NoPendingLimit)?;

        if env.ledger().timestamp() < pending.effective_time {
            return Err(Error::DelayNotElapsed);
        }

        env.storage()
            .persistent()
            .set(&DataKey::Limit(asset, account), &pending.limit);
        env.storage()
            .persistent()
            .remove(&DataKey::Pending(asset, account));
        Ok(pending.limit)
    }

    /// Compute the amount consumed within the rolling 24-hour window.
    pub fn consumed(env: Env, asset: Address, account: Address) -> i128 {
        let now = env.ledger().timestamp();
        let entries = Self::pruned_entries(&env, &asset, &account, now);
        let mut total: i128 = 0;
        for entry in entries.iter() {
            total += entry.amount;
        }
        total
    }

    /// Compute the remaining allowance within the rolling 24-hour window.
    pub fn remaining(env: Env, asset: Address, account: Address) -> i128 {
        let limit = Self::get_limit(env.clone(), asset.clone(), account.clone());
        let consumed = Self::consumed(env, asset, account);
        let remaining = limit - consumed;
        if remaining < 0 {
            0
        } else {
            remaining
        }
    }

    /// Record a spend for (asset, account), enforcing the rolling 24-hour limit.
    pub fn spend(
        env: Env,
        asset: Address,
        account: Address,
        amount: i128,
    ) -> Result<i128, Error> {
        account.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let now = env.ledger().timestamp();
        let limit = Self::get_limit(env.clone(), asset.clone(), account.clone());

        let mut entries = Self::pruned_entries(&env, &asset, &account, now);
        let mut consumed: i128 = 0;
        for entry in entries.iter() {
            consumed += entry.amount;
        }

        let remaining = limit - consumed;
        if amount > remaining {
            return Err(Error::ExceedsAllowance);
        }

        if entries.len() >= MAX_ENTRIES {
            return Err(Error::TooManyEntries);
        }

        entries.push_back(SpendEntry {
            timestamp: now,
            amount,
        });

        env.storage()
            .persistent()
            .set(&DataKey::Spends(asset.clone(), account.clone()), &entries);

        env.events().publish(
            (symbol_short!("spend"), asset, account),
            (amount, now),
        );

        Ok(remaining - amount)
    }

    /// Read the stored entries for (asset, account), dropping any that fall
    /// outside the rolling 24-hour window ending at `now`.
    fn pruned_entries(
        env: &Env,
        asset: &Address,
        account: &Address,
        now: u64,
    ) -> Vec<SpendEntry> {
        let stored: Vec<SpendEntry> = env
            .storage()
            .persistent()
            .get(&DataKey::Spends(asset.clone(), account.clone()))
            .unwrap_or_else(|| Vec::new(env));

        let cutoff = now.saturating_sub(WINDOW_SECONDS);
        let mut pruned: Vec<SpendEntry> = Vec::new(env);
        for entry in stored.iter() {
            // Keep entries strictly newer than the cutoff so that exactly
            // 24 hours of history is retained.
            if entry.timestamp > cutoff {
                pruned.push_back(entry);
            }
        }
        pruned
    }
}

mod test;
```

src/test.rs:

```rust
#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Env};

fn setup() -> (Env, SpendPolicyContractClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, SpendPolicyContract);
    let client = SpendPolicyContractClient::new(&env, &contract_id);

    let master = Address::generate(&env);
    let asset = Address::generate(&env);
    let account = Address::generate(&env);

    client.initialize(&master);
    (env, client, master, asset, account)
}

#[test]
fn rejects_spend_exceeding_remaining_allowance() {
    let (env, client, _master, asset, account) = setup();
    env.ledger().set_timestamp(1_000);

    client.set_limit(&asset, &account, &100);

    // First spend consumes 60 of the 100 allowance.
    let remaining = client.spend(&asset, &account, &60);
    assert_eq!(remaining, 40);

    // A spend of 50 exceeds the remaining 40 and must be rejected.
    let result = client.try_spend(&asset, &account, &50);
    assert_eq!(result, Err(Ok(Error::ExceedsAllowance)));

    // A spend of exactly the remaining allowance succeeds.
    let remaining = client.spend(&asset, &account, &40);
    assert_eq!(remaining, 0);

    // Any further spend is rejected.
    let result = client.try_spend(&asset, &account, &1);
    assert_eq!(result, Err(Ok(Error::ExceedsAllowance)));
}

#[test]
fn allowance_restores_as_time_advances() {
    let (env, client, _master, asset, account) = setup();
    env.ledger().set_timestamp(1_000);

    client.set_limit(&asset, &account, &100);
    client.spend(&asset, &account, &100);
    assert_eq!(client.remaining(&asset, &account), 0);

    // Half a day later, nothing has expired yet.
    env.ledger().set_timestamp(1_000 + WINDOW_SECONDS / 2);
    assert_eq!(client.remaining(&asset, &account), 0);
    let result = client.try_spend(&asset, &account, &10);
    assert_eq!(result, Err(Ok(Error::ExceedsAllowance)));

    // After the full 24-hour window, the spend expires and allowance restores.
    env.ledger().set_timestamp(1_000 + WINDOW_SECONDS + 1);
    assert_eq!(client.remaining(&asset, &account), 100);
    let remaining = client.spend(&asset, &account, &100);
    assert_eq!(remaining, 0);
}

#[test]
fn sliding_window_partial_restoration() {
    let (env, client, _master, asset, account) = setup();
    env.ledger().set_timestamp(1_000);

    client.set_limit(&asset, &account, &100);
    client.spend(&asset, &account, &40);

    // 12 hours later spend another 40.
    env.ledger().set_timestamp(1_000 + WINDOW_SECONDS / 2);
    client.spend(&asset, &account, &40);
    assert_eq!(client.remaining(&asset, &account), 20);

    // 13 hours after the first spend (but only 1 hour after the second),
    // the first spend has expired, restoring 40 of allowance.
    env.ledger().set_timestamp(1_000 + WINDOW_SECONDS / 2 + 3_600);
    assert_eq!(client.remaining(&asset, &account), 60);

    // The second spend is still within the window.
    env.ledger().set_timestamp(1_000 + WINDOW_SECONDS / 2 + 3_600 + 1);
    assert_eq!(client.remaining(&asset, &account), 60);
}

#[test]
fn delayed_master_key_override() {
    let (env, client, _master, asset, account) = setup();
    env.ledger().set_timestamp(1_000);

    client.set_limit(&asset, &account, &100);
    assert_eq!(client.get_limit(&asset, &account), 100);

    // Schedule a new limit; it should not apply immediately.
    client.schedule_limit(&asset, &account, &500);
    assert_eq!(client.get_limit(&asset, &account), 100);

    let pending = client.get_pending_limit(&asset, &account).unwrap();
    assert_eq!(pending.limit, 500);
    assert_eq!(pending.effective_time, 1_000 + LIMIT_CHANGE_DELAY);

    // Applying before the delay elapses fails.
    let result = client.try_apply_pending_limit(&asset, &account);
    assert_eq!(result, Err(Ok(Error::DelayNotElapsed)));

    // Just before the delay elapses, still fails.
    env.ledger().set_timestamp(1_000 + LIMIT_CHANGE_DELAY - 1);
    let result = client.try_apply_pending_limit(&asset, &account);
    assert_eq!(result, Err(Ok(Error::DelayNotElapsed)));

    // Once the delay elapses, the new limit applies.
    env.ledger().set_timestamp(1_000 + LIMIT_CHANGE_DELAY);
    let applied = client.apply_pending_limit(&asset, &account);
    assert_eq!(applied, 500);
    assert_eq!(client.get_limit(&asset, &account), 500);
    assert!(client.get_pending_limit(&asset, &account).is_none());

    // Spending up to the new limit is now allowed.
    let remaining = client.spend(&asset, &account, &500);
    assert_eq!(remaining, 0);
}

#[test]
fn apply_without_pending_fails() {
    let (env, client, _master, asset, account) = setup();
    env.ledger().set_timestamp(1_000);

    let result = client.try_apply_pending_limit(&asset, &account);
    assert_eq!(result, Err(Ok(Error::NoPendingLimit)));
}

#[test]
fn rejects_non_positive_amounts() {
    let (env, client, _master, asset, account) = setup();
    env.ledger().set_timestamp(1_000);
    client.set_limit(&asset, &account, &100);

    let result = client.try_spend(&asset, &account, &0);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));

    let result = client.try_spend(&asset, &account, &-5);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn double_initialize_fails() {
    let (env, client, master, _asset, _account) = setup();
    let _ = env;
    let result = client.try_initialize(&master);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}