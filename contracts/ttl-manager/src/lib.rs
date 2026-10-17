#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Env, Symbol, Vec,
};

/// Storage keys used by the TTL manager contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Tracks the reimbursement ledger balance (in stroops) for a given payer.
    Reimbursement(soroban_sdk::Address),
    /// Tracks the list of persistent entry keys being monitored.
    TrackedEntry(u32),
    /// Number of tracked persistent entries.
    TrackedCount,
    /// Total rent deposited into the reimbursement pool.
    TotalDeposited,
    /// Total rent withdrawn from the reimbursement pool.
    TotalWithdrawn,
}

/// Errors returned by the TTL manager.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TtlError {
    /// The provided threshold is invalid (e.g. zero or larger than extend_by).
    InvalidThreshold = 1,
    /// The provided extension amount is invalid (e.g. zero).
    InvalidExtension = 2,
    /// Insufficient reimbursement balance for the requested withdrawal.
    InsufficientBalance = 3,
    /// Arithmetic overflow while computing rent.
    Overflow = 4,
}

/// Result of a TTL check / extension operation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TtlStatus {
    /// The instance storage TTL before the operation.
    pub instance_ttl_before: u32,
    /// The instance storage TTL after the operation.
    pub instance_ttl_after: u32,
    /// Whether the instance TTL was extended.
    pub instance_extended: bool,
    /// Number of persistent entries that were extended.
    pub persistent_extended: u32,
}

/// Rent estimation parameters.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RentEstimate {
    /// Estimated rent in stroops for the given entries over the ledger count.
    pub estimated_rent: i128,
    /// Number of entries considered.
    pub entry_count: u32,
    /// Number of ledgers the estimate covers.
    pub ledger_count: u32,
}

/// Base rent cost per ledger per byte (in stroops). Mirrors Soroban's
/// rent model closely enough for estimation purposes.
const RENT_PER_LEDGER_PER_BYTE: i128 = 1;
/// Fixed overhead per entry per ledger (in stroops).
const RENT_PER_LEDGER_PER_ENTRY: i128 = 10;
/// Approximate size in bytes of a persistent entry key + value.
const APPROX_ENTRY_SIZE_BYTES: i128 = 64;

#[contract]
pub struct TtlManager;

#[contractimpl]
impl TtlManager {
    /// Extend the instance storage TTL and all tracked persistent entries'
    /// TTLs if their current TTL is below `threshold_ledgers`.
    ///
    /// * `threshold_ledgers` - If the current TTL is below this value, the TTL
    ///   will be extended.
    /// * `extend_by` - The number of ledgers to extend the TTL by. Must be
    ///   greater than or equal to `threshold_ledgers`.
    ///
    /// Returns a [`TtlStatus`] describing what was extended.
    pub fn extend_ttl_if_needed(
        env: Env,
        threshold_ledgers: u32,
        extend_by: u32,
    ) -> Result<TtlStatus, TtlError> {
        if threshold_ledgers == 0 || extend_by == 0 || extend_by < threshold_ledgers {
            return Err(TtlError::InvalidThreshold);
        }

        // --- Instance storage TTL ---
        let instance_ttl_before = env.storage().instance().get_ttl();
        let mut instance_extended = false;
        if instance_ttl_before < threshold_ledgers {
            env.storage()
                .instance()
                .extend_ttl(threshold_ledgers, extend_by);
            instance_extended = true;
        }
        let instance_ttl_after = env.storage().instance().get_ttl();

        // --- Persistent storage TTLs ---
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TrackedCount)
            .unwrap_or(0);

        let mut persistent_extended: u32 = 0;
        let mut i: u32 = 0;
        while i < count {
            if let Some(key) = env
                .storage()
                .instance()
                .get::<DataKey, Symbol>(&DataKey::TrackedEntry(i))
            {
                let persistent = env.storage().persistent();
                let current_ttl = persistent.get_ttl(&key);
                if current_ttl < threshold_ledgers {
                    persistent.extend_ttl(&key, threshold_ledgers, extend_by);
                    persistent_extended += 1;
                }
            }
            i += 1;
        }

        // Emit an event so off-chain workers can observe the extension.
        env.events().publish(
            (symbol_short!("ttl_ext"),),
            (instance_extended, persistent_extended),
        );

        Ok(TtlStatus {
            instance_ttl_before,
            instance_ttl_after,
            instance_extended,
            persistent_extended,
        })
    }

    /// Register a persistent storage key to be monitored by
    /// [`extend_ttl_if_needed`].
    pub fn track_entry(env: Env, key: Symbol) {
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TrackedCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TrackedEntry(count), &key);
        env.storage()
            .instance()
            .set(&DataKey::TrackedCount, &(count + 1));
    }

    /// Returns the number of tracked persistent entries.
    pub fn tracked_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TrackedCount)
            .unwrap_or(0)
    }

    /// Returns the current instance storage TTL.
    pub fn instance_ttl(env: Env) -> u32 {
        env.storage().instance().get_ttl()
    }

    /// Returns the current TTL for a tracked persistent entry.
    pub fn entry_ttl(env: Env, key: Symbol) -> u32 {
        env.storage().persistent().get_ttl(&key)
    }

    /// Estimate the rent (in stroops) required to keep `entry_count` entries
    /// alive for `ledger_count` ledgers.
    pub fn estimate_rent(entry_count: u32, ledger_count: u32) -> Result<RentEstimate, TtlError> {
        let entries = entry_count as i128;
        let ledgers = ledger_count as i128;

        let per_entry = entries
            .checked_mul(ledgers)
            .ok_or(TtlError::Overflow)?;
        let byte_cost = per_entry
            .checked_mul(APPROX_ENTRY_SIZE_BYTES)
            .and_then(|v| v.checked_mul(RENT_PER_LEDGER_PER_BYTE))
            .ok_or(TtlError::Overflow)?;
        let entry_cost = per_entry
            .checked_mul(RENT_PER_LEDGER_PER_ENTRY)
            .ok_or(TtlError::Overflow)?;
        let estimated_rent = byte_cost.checked_add(entry_cost).ok_or(TtlError::Overflow)?;

        Ok(RentEstimate {
            estimated_rent,
            entry_count,
            ledger_count,
        })
    }

    /// Estimate the rent for all currently tracked entries over `ledger_count`
    /// ledgers.
    pub fn estimate_tracked_rent(env: Env, ledger_count: u32) -> Result<RentEstimate, TtlError> {
        let count = Self::tracked_count(env);
        Self::estimate_rent(count, ledger_count)
    }

    /// Deposit `amount` stroops into the reimbursement pool for `payer`.
    pub fn deposit_reimbursement(env: Env, payer: soroban_sdk::Address, amount: i128) {
        payer.require_auth();
        let key = DataKey::Reimbursement(payer.clone());
        let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
        env.storage().instance().set(&key, &(current + amount));

        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalDeposited)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalDeposited, &(total + amount));

        env.events()
            .publish((symbol_short!("reimb_dep"), payer), amount);
    }

    /// Withdraw `amount` stroops from the reimbursement pool for `payer`.
    pub fn withdraw_reimbursement(
        env: Env,
        payer: soroban_sdk::Address,
        amount: i128,
    ) -> Result<i128, TtlError> {
        payer.require_auth();
        let key = DataKey::Reimbursement(payer.clone());
        let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
        if current < amount {
            return Err(TtlError::InsufficientBalance);
        }
        let new_balance = current - amount;
        env.storage().instance().set(&key, &new_balance);

        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalWithdrawn)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalWithdrawn, &(total + amount));

        env.events()
            .publish((symbol_short!("reimb_wd"), payer), amount);

        Ok(new_balance)
    }

    /// Returns the reimbursement balance for `payer`.
    pub fn reimbursement_balance(env: Env, payer: soroban_sdk::Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Reimbursement(payer))
            .unwrap_or(0)
    }

    /// Returns the total amount deposited into the reimbursement pool.
    pub fn total_deposited(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalDeposited)
            .unwrap_or(0)
    }

    /// Returns the total amount withdrawn from the reimbursement pool.
    pub fn total_withdrawn(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalWithdrawn)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{Env, Symbol};

    fn setup() -> (Env, TtlManagerClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TtlManager);
        let client = TtlManagerClient::new(&env, &contract_id);
        (env, client)
    }

    #[test]
    fn test_instance_ttl_extended_below_threshold() {
        let (env, client) = setup();

        // Freshly deployed contract has a default TTL. Advance the ledger so
        // the TTL is below our threshold.
        env.ledger().with_mut(|li| {
            li.sequence_number += 100;
        });

        let before = client.instance_ttl();
        let status = client.extend_ttl_if_needed(&1_000, &10_000);
        assert!(status.instance_extended);
        assert_eq!(status.instance_ttl_before, before);
        assert!(status.instance_ttl_after >= 1_000);
        assert!(client.instance_ttl() >= 1_000);
    }

    #[test]
    fn test_instance_ttl_not_extended_above_threshold() {
        let (env, client) = setup();

        // Extend once with a large TTL.
        client.extend_ttl_if_needed(&100, &100_000);
        let before = client.instance_ttl();

        // Threshold well below current TTL -> no extension.
        let status = client.extend_ttl_if_needed(&10, &20);
        assert!(!status.instance_extended);
        assert_eq!(status.instance_ttl_before, before);
        assert_eq!(status.instance_ttl_after, before);
    }

    #[test]
    fn test_invalid_threshold() {
        let (_env, client) = setup();
        assert_eq!(
            client.try_extend_ttl_if_needed(&0, &100),
            Err(Ok(TtlError::InvalidThreshold))
        );
        assert_eq!(
            client.try_extend_ttl_if_needed(&100, &0),
            Err(Ok(TtlError::InvalidThreshold))
        );
        assert_eq!(
            client.try_extend_ttl_if_needed(&200, &100),
            Err(Ok(TtlError::InvalidThreshold))
        );
    }

    #[test]
    fn test_persistent_entry_ttl_bumped() {
        let (env, client) = setup();
        let key = Symbol::new(&env, "mykey");

        // Write a persistent entry directly through the contract's storage.
        let contract_id = client.address.clone();
        env.as_contract(&contract_id, || {
            env.storage().persistent().set(&key, &42u32);
        });

        client.track_entry(&key);
        assert_eq!(client.tracked_count(), 1);

        // Advance ledger so the persistent TTL is below threshold.
        env.ledger().with_mut(|li| {
            li.sequence_number += 100;
        });

        let status = client.extend_ttl_if_needed(&1_000, &10_000);
        assert_eq!(status.persistent_extended, 1);
        assert!(client.entry_ttl(&key) >= 1_000);
    }

    #[test]
    fn test_rent_estimation() {
        let estimate = TtlManager::estimate_rent(10, 1_000).unwrap();
        assert_eq!(estimate.entry_count, 10);
        assert_eq!(estimate.ledger_count, 1_000);
        // 10 entries * 1000 ledgers * (64 bytes * 1 + 10) = 10_000 * 74 = 740_000
        assert_eq!(estimate.estimated_rent, 740_000);
    }

    #[test]
    fn test_estimate_tracked_rent() {
        let (env, client) = setup();
        let k1 = Symbol::new(&env, "k1");
        let k2 = Symbol::new(&env, "k2");
        client.track_entry(&k1);
        client.track_entry(&k2);

        let estimate = client.estimate_tracked_rent(&100);
        assert_eq!(estimate.entry_count, 2);
        assert_eq!(estimate.ledger_count, 100);
        assert_eq!(estimate.estimated_rent, 2 * 100 * 74);
    }

    #[test]
    fn test_reimbursement_deposit_and_withdraw() {
        let (env, client) = setup();
        let payer = Address::generate(&env);

        client.deposit_reimbursement(&payer, &1_000);
        assert_eq!(client.reimbursement_balance(&payer), 1_000);
        assert_eq!(client.total_deposited(), 1_000);

        let remaining = client.withdraw_reimbursement(&payer, &400);
        assert_eq!(remaining, 600);
        assert_eq!(client.reimbursement_balance(&payer), 600);
        assert_eq!(client.total_withdrawn(), 400);
    }

    #[test]
    fn test_reimbursement_insufficient_balance() {
        let (env, client) = setup();
        let payer = Address::generate(&env);

        client.deposit_reimbursement(&payer, &100);
        assert_eq!(
            client.try_withdraw_reimbursement(&payer, &200),
            Err(Ok(TtlError::InsufficientBalance))
        );
    }

    #[test]
    fn test_ttl_bumped_before_threshold_expiration() {
        // Simulate ledger increments and verify the TTL is bumped before the
        // threshold is reached.
        let (env, client) = setup();
        let key = Symbol::new(&env, "watched");
        let contract_id = client.address.clone();
        env.as_contract(&contract_id, || {
            env.storage().persistent().set(&key, &1u32);
        });
        client.track_entry(&key);

        let threshold = 500u32;
        let extend_by = 5_000u32;

        // Extend once to establish a known TTL.
        client.extend_ttl_if_needed(&threshold, &extend_by);
        let initial_ttl = client.entry_ttl(&key);
        assert!(initial_ttl >= threshold);

        // Advance the ledger in steps, checking that TTL is bumped before it
        // drops below the threshold.
        let mut remaining = initial_ttl;
        let step = 100u32;
        while remaining > step {
            env.ledger().with_mut(|li| {
                li.sequence_number += step;
            });
            remaining = remaining.saturating_sub(step);

            if remaining < threshold {
                let status = client.extend_ttl_if_needed(&threshold, &extend_by);
                assert!(status.instance_extended || status.persistent_extended > 0);
                remaining = client.entry_ttl(&key);
                assert!(remaining >= threshold);
            }
        }
    }
}