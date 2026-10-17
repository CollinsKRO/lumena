#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env,
};

/// Storage keys for the inheritance vault.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Owner,
    Beneficiary,
    DormancyPeriod,
    LastHeartbeat,
    Claimed,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    HeartbeatActive = 4,
    AlreadyClaimed = 5,
    InvalidDormancyPeriod = 6,
    NoBeneficiary = 7,
}

#[contract]
pub struct InheritanceVault;

#[contractimpl]
impl InheritanceVault {
    /// Initialize the vault with an owner, a beneficiary and a dormancy period (in seconds).
    pub fn initialize(
        env: Env,
        owner: Address,
        beneficiary: Address,
        dormancy_period: u64,
    ) {
        if env.storage().instance().has(&DataKey::Owner) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        if dormancy_period == 0 {
            panic_with_error!(&env, Error::InvalidDormancyPeriod);
        }

        owner.require_auth();

        let now = env.ledger().timestamp();

        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage()
            .instance()
            .set(&DataKey::Beneficiary, &beneficiary);
        env.storage()
            .instance()
            .set(&DataKey::DormancyPeriod, &dormancy_period);
        env.storage().instance().set(&DataKey::LastHeartbeat, &now);
        env.storage().instance().set(&DataKey::Claimed, &false);

        env.events()
            .publish((symbol_short!("init"), owner), beneficiary);
    }

    /// Refresh the heartbeat timestamp. Owner-only.
    pub fn heartbeat(env: Env) {
        let owner = Self::read_owner(&env);
        owner.require_auth();

        if Self::is_claimed(&env) {
            panic_with_error!(&env, Error::AlreadyClaimed);
        }

        let now = env.ledger().timestamp();
        env.storage().instance().set(&DataKey::LastHeartbeat, &now);

        env.events().publish((symbol_short!("heartbeat"),), now);
    }

    /// Update the beneficiary. Owner-only.
    pub fn set_beneficiary(env: Env, beneficiary: Address) {
        let owner = Self::read_owner(&env);
        owner.require_auth();

        if Self::is_claimed(&env) {
            panic_with_error!(&env, Error::AlreadyClaimed);
        }

        env.storage()
            .instance()
            .set(&DataKey::Beneficiary, &beneficiary);

        env.events()
            .publish((symbol_short!("set_benef"), owner), beneficiary);
    }

    /// Update the dormancy period (in seconds). Owner-only.
    pub fn set_dormancy(env: Env, dormancy_period: u64) {
        let owner = Self::read_owner(&env);
        owner.require_auth();

        if dormancy_period == 0 {
            panic_with_error!(&env, Error::InvalidDormancyPeriod);
        }

        if Self::is_claimed(&env) {
            panic_with_error!(&env, Error::AlreadyClaimed);
        }

        env.storage()
            .instance()
            .set(&DataKey::DormancyPeriod, &dormancy_period);

        env.events()
            .publish((symbol_short!("set_dorm"), owner), dormancy_period);
    }

    /// Claim custody of the vault. Callable by the beneficiary once the
    /// dormancy period has elapsed since the last heartbeat.
    pub fn claim(env: Env) -> Address {
        if !env.storage().instance().has(&DataKey::Owner) {
            panic_with_error!(&env, Error::NotInitialized);
        }

        if Self::is_claimed(&env) {
            panic_with_error!(&env, Error::AlreadyClaimed);
        }

        let beneficiary: Address = env
            .storage()
            .instance()
            .get(&DataKey::Beneficiary)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoBeneficiary));

        beneficiary.require_auth();

        let last_heartbeat: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LastHeartbeat)
            .unwrap_or(0);
        let dormancy_period: u64 = env
            .storage()
            .instance()
            .get(&DataKey::DormancyPeriod)
            .unwrap_or(0);

        let now = env.ledger().timestamp();

        if now.saturating_sub(last_heartbeat) <= dormancy_period {
            panic_with_error!(&env, Error::HeartbeatActive);
        }

        // Transfer custody/ownership to the beneficiary.
        env.storage()
            .instance()
            .set(&DataKey::Owner, &beneficiary);
        env.storage().instance().set(&DataKey::Claimed, &true);

        env.events()
            .publish((symbol_short!("claim"), beneficiary.clone()), now);

        beneficiary
    }

    // ----- View helpers -----

    pub fn get_owner(env: Env) -> Address {
        Self::read_owner(&env)
    }

    pub fn get_beneficiary(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Beneficiary)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoBeneficiary))
    }

    pub fn get_dormancy_period(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::DormancyPeriod)
            .unwrap_or(0)
    }

    pub fn get_last_heartbeat(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::LastHeartbeat)
            .unwrap_or(0)
    }

    pub fn is_claimed(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Claimed)
            .unwrap_or(false)
    }

    /// Returns true if the dormancy period has elapsed and a claim is possible.
    pub fn is_claimable(env: Env) -> bool {
        if Self::is_claimed(&env) {
            return false;
        }
        let last_heartbeat: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LastHeartbeat)
            .unwrap_or(0);
        let dormancy_period: u64 = env
            .storage()
            .instance()
            .get(&DataKey::DormancyPeriod)
            .unwrap_or(0);
        let now = env.ledger().timestamp();
        now.saturating_sub(last_heartbeat) > dormancy_period
    }

    fn read_owner(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Owner)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::Env;

    fn setup() -> (Env, InheritanceVaultClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, InheritanceVault);
        let client = InheritanceVaultClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let beneficiary = Address::generate(&env);

        client.initialize(&owner, &beneficiary, &1000u64);

        (env, client, owner, beneficiary)
    }

    #[test]
    fn test_initialize_sets_state() {
        let (env, client, owner, beneficiary) = setup();

        assert_eq!(client.get_owner(), owner);
        assert_eq!(client.get_beneficiary(), beneficiary);
        assert_eq!(client.get_dormancy_period(), 1000);
        assert_eq!(client.get_last_heartbeat(), env.ledger().timestamp());
        assert!(!client.is_claimed());
    }

    #[test]
    fn test_heartbeat_updates_timestamp() {
        let (env, client, _owner, _beneficiary) = setup();

        env.ledger().with_mut(|li| li.timestamp = 500);
        client.heartbeat();

        assert_eq!(client.get_last_heartbeat(), 500);
    }

    #[test]
    fn test_claim_fails_while_heartbeat_active() {
        let (env, client, _owner, _beneficiary) = setup();

        // Advance time but stay within the dormancy period.
        env.ledger().with_mut(|li| li.timestamp = 500);

        let result = client.try_claim();
        assert!(result.is_err());
        assert!(!client.is_claimed());
    }

    #[test]
    fn test_claim_fails_exactly_at_dormancy_boundary() {
        let (env, client, _owner, _beneficiary) = setup();

        // Exactly at the dormancy period: not yet claimable (must be strictly greater).
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let result = client.try_claim();
        assert!(result.is_err());
        assert!(!client.is_claimed());
    }

    #[test]
    fn test_claim_succeeds_after_dormancy_period() {
        let (env, client, _owner, beneficiary) = setup();

        // Advance time beyond the dormancy period.
        env.ledger().with_mut(|li| li.timestamp = 1001);

        let claimed = client.claim();
        assert_eq!(claimed, beneficiary);
        assert!(client.is_claimed());
        // Custody transferred to beneficiary.
        assert_eq!(client.get_owner(), beneficiary);
    }

    #[test]
    fn test_heartbeat_resets_dormancy() {
        let (env, client, _owner, _beneficiary) = setup();

        env.ledger().with_mut(|li| li.timestamp = 900);
        client.heartbeat();

        // 900 + 1000 = 1900; at 1500 should still fail.
        env.ledger().with_mut(|li| li.timestamp = 1500);
        assert!(client.try_claim().is_err());

        // At 1901 should succeed.
        env.ledger().with_mut(|li| li.timestamp = 1901);
        assert!(client.claim().is_ok());
    }

    #[test]
    fn test_set_beneficiary() {
        let (env, client, _owner, _beneficiary) = setup();

        let new_beneficiary = Address::generate(&env);
        client.set_beneficiary(&new_beneficiary);

        assert_eq!(client.get_beneficiary(), new_beneficiary);
    }

    #[test]
    fn test_set_dormancy() {
        let (env, client, _owner, _beneficiary) = setup();

        client.set_dormancy(&2000u64);
        assert_eq!(client.get_dormancy_period(), 2000);

        // At 1500 with new dormancy of 2000, claim should fail.
        env.ledger().with_mut(|li| li.timestamp = 1500);
        assert!(client.try_claim().is_err());

        // At 2001 should succeed.
        env.ledger().with_mut(|li| li.timestamp = 2001);
        assert!(client.claim().is_ok());
    }

    #[test]
    fn test_double_claim_fails() {
        let (env, client, _owner, _beneficiary) = setup();

        env.ledger().with_mut(|li| li.timestamp = 1001);
        client.claim();

        let result = client.try_claim();
        assert!(result.is_err());
    }

    #[test]
    fn test_is_claimable() {
        let (env, client, _owner, _beneficiary) = setup();

        assert!(!client.is_claimable());

        env.ledger().with_mut(|li| li.timestamp = 1001);
        assert!(client.is_claimable());

        client.claim();
        assert!(!client.is_claimable());
    }
}