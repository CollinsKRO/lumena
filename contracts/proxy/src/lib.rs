#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, BytesN, Env, Vec,
};

/// Storage keys are defined independently of the logic so that state survives
/// WASM upgrades. Instance storage holds small, frequently-read config; the
/// signer set and pending upgrade live in persistent storage.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Contract admin (can manage signers). Instance storage.
    Admin,
    /// Required approval threshold. Instance storage.
    Threshold,
    /// Timelock duration in seconds. Instance storage.
    Timelock,
    /// Set of authorized upgrade signers. Persistent storage.
    Signers,
    /// Pending upgrade proposal. Persistent storage.
    PendingUpgrade,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    /// Hash of the new contract WASM to deploy.
    pub new_wasm_hash: BytesN<32>,
    /// Ledger timestamp at which the upgrade becomes executable.
    pub unlock_timestamp: u64,
    /// Signers that have approved this proposal.
    pub approvals: Vec<Address>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ProxyError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    NoPendingUpgrade = 4,
    AlreadyApproved = 5,
    ThresholdNotMet = 6,
    TimelockNotElapsed = 7,
    InvalidThreshold = 8,
    NotASigner = 9,
    PendingUpgradeExists = 10,
}

#[contract]
pub struct ProxyContract;

#[contractimpl]
impl ProxyContract {
    /// Initialize the proxy with an admin, an initial signer set, an approval
    /// threshold, and a timelock duration (seconds).
    pub fn initialize(
        env: Env,
        admin: Address,
        signers: Vec<Address>,
        threshold: u32,
        timelock: u64,
    ) -> Result<(), ProxyError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ProxyError::AlreadyInitialized);
        }
        if threshold == 0 || threshold > signers.len() {
            return Err(ProxyError::InvalidThreshold);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        env.storage().instance().set(&DataKey::Timelock, &timelock);
        env.storage().persistent().set(&DataKey::Signers, &signers);

        Ok(())
    }

    /// Replace the signer set. Only the admin may call this.
    pub fn set_signers(
        env: Env,
        admin: Address,
        signers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), ProxyError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        if threshold == 0 || threshold > signers.len() {
            return Err(ProxyError::InvalidThreshold);
        }
        env.storage().persistent().set(&DataKey::Signers, &signers);
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        Ok(())
    }

    /// Propose a new WASM hash to upgrade to. The proposal records the current
    /// timestamp plus the configured timelock as its unlock timestamp.
    pub fn propose_upgrade(
        env: Env,
        signer: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), ProxyError> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;

        if env.storage().persistent().has(&DataKey::PendingUpgrade) {
            return Err(ProxyError::PendingUpgradeExists);
        }

        let timelock: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Timelock)
            .ok_or(ProxyError::NotInitialized)?;
        let unlock_timestamp = env.ledger().timestamp().saturating_add(timelock);

        let mut approvals = Vec::new(&env);
        approvals.push_back(signer);

        let pending = PendingUpgrade {
            new_wasm_hash,
            unlock_timestamp,
            approvals,
        };
        env.storage()
            .persistent()
            .set(&DataKey::PendingUpgrade, &pending);

        Ok(())
    }

    /// Approve the currently pending upgrade. Each signer may approve once.
    pub fn approve_upgrade(env: Env, signer: Address) -> Result<(), ProxyError> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;

        let mut pending: PendingUpgrade = env
            .storage()
            .persistent()
            .get(&DataKey::PendingUpgrade)
            .ok_or(ProxyError::NoPendingUpgrade)?;

        if pending.approvals.contains(&signer) {
            return Err(ProxyError::AlreadyApproved);
        }
        pending.approvals.push_back(signer);

        env.storage()
            .persistent()
            .set(&DataKey::PendingUpgrade, &pending);

        Ok(())
    }

    /// Execute the pending upgrade. Requires the approval threshold to be met
    /// and the timelock to have elapsed. Calls
    /// `update_current_contract_wasm`, which preserves instance and persistent
    /// storage.
    pub fn execute_upgrade(env: Env) -> Result<(), ProxyError> {
        let pending: PendingUpgrade = env
            .storage()
            .persistent()
            .get(&DataKey::PendingUpgrade)
            .ok_or(ProxyError::NoPendingUpgrade)?;

        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .ok_or(ProxyError::NotInitialized)?;

        if pending.approvals.len() < threshold {
            return Err(ProxyError::ThresholdNotMet);
        }

        if env.ledger().timestamp() < pending.unlock_timestamp {
            return Err(ProxyError::TimelockNotElapsed);
        }

        // Clear the pending proposal before upgrading so that the new logic
        // starts from a clean slate.
        env.storage().persistent().remove(&DataKey::PendingUpgrade);

        env.deployer()
            .update_current_contract_wasm(pending.new_wasm_hash);

        Ok(())
    }

    /// Cancel a pending upgrade. Only the admin may cancel.
    pub fn cancel_upgrade(env: Env, admin: Address) -> Result<(), ProxyError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        if !env.storage().persistent().has(&DataKey::PendingUpgrade) {
            return Err(ProxyError::NoPendingUpgrade);
        }
        env.storage().persistent().remove(&DataKey::PendingUpgrade);
        Ok(())
    }

    // ---- Read-only helpers ----

    pub fn get_admin(env: Env) -> Result<Address, ProxyError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ProxyError::NotInitialized)
    }

    pub fn get_threshold(env: Env) -> Result<u32, ProxyError> {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .ok_or(ProxyError::NotInitialized)
    }

    pub fn get_timelock(env: Env) -> Result<u64, ProxyError> {
        env.storage()
            .instance()
            .get(&DataKey::Timelock)
            .ok_or(ProxyError::NotInitialized)
    }

    pub fn get_signers(env: Env) -> Result<Vec<Address>, ProxyError> {
        env.storage()
            .persistent()
            .get(&DataKey::Signers)
            .ok_or(ProxyError::NotInitialized)
    }

    pub fn get_pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        env.storage().persistent().get(&DataKey::PendingUpgrade)
    }

    // ---- Internal helpers ----

    fn require_admin(env: &Env, caller: &Address) -> Result<(), ProxyError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ProxyError::NotInitialized)?;
        if &admin != caller {
            return Err(ProxyError::Unauthorized);
        }
        Ok(())
    }

    fn require_signer(env: &Env, caller: &Address) -> Result<(), ProxyError> {
        let signers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Signers)
            .ok_or(ProxyError::NotInitialized)?;
        if !signers.contains(caller) {
            return Err(ProxyError::NotASigner);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        Env,
    };

    fn setup(env: &Env, threshold: u32, timelock: u64) -> (ProxyContractClient, Vec<Address>) {
        let admin = Address::generate(env);
        let s1 = Address::generate(env);
        let s2 = Address::generate(env);
        let s3 = Address::generate(env);
        let mut signers = Vec::new(env);
        signers.push_back(s1.clone());
        signers.push_back(s2.clone());
        signers.push_back(s3.clone());

        let contract_id = env.register(ProxyContract, ());
        let client = ProxyContractClient::new(env, &contract_id);
        client.initialize(&admin, &signers, &threshold, &timelock);
        (client, signers)
    }

    fn set_time(env: &Env, ts: u64) {
        env.ledger().set(LedgerInfo {
            timestamp: ts,
            protocol_version: 22,
            sequence_number: 1,
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 16,
            max_entry_ttl: 6_312_000,
        });
    }

    fn dummy_hash(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[7u8; 32])
    }

    #[test]
    fn test_initialize_and_reads() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, signers) = setup(&env, 2, 100);
        assert_eq!(client.get_threshold(), 2);
        assert_eq!(client.get_timelock(), 100);
        assert_eq!(client.get_signers(), signers);
    }

    #[test]
    fn test_double_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, signers) = setup(&env, 2, 100);
        let admin = Address::generate(&env);
        let res = client.try_initialize(&admin, &signers, &2, &100);
        assert_eq!(res, Err(Ok(ProxyError::AlreadyInitialized)));
    }

    #[test]
    fn test_propose_and_approve() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (client, signers) = setup(&env, 2, 100);

        client.propose_upgrade(&signers.get(0).unwrap(), &dummy_hash(&env));
        let pending = client.get_pending_upgrade().unwrap();
        assert_eq!(pending.unlock_timestamp, 1_100);
        assert_eq!(pending.approvals.len(), 1);

        client.approve_upgrade(&signers.get(1).unwrap());
        let pending = client.get_pending_upgrade().unwrap();
        assert_eq!(pending.approvals.len(), 2);
    }

    #[test]
    fn test_duplicate_approval_fails() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (client, signers) = setup(&env, 2, 100);
        let s0 = signers.get(0).unwrap();
        client.propose_upgrade(&s0, &dummy_hash(&env));
        let res = client.try_approve_upgrade(&s0);
        assert_eq!(res, Err(Ok(ProxyError::AlreadyApproved)));
    }

    #[test]
    fn test_execute_rejected_before_threshold() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (client, signers) = setup(&env, 3, 100);
        client.propose_upgrade(&signers.get(0).unwrap(), &dummy_hash(&env));
        // Advance past timelock but keep approvals below threshold.
        set_time(&env, 2_000);
        let res = client.try_execute_upgrade();
        assert_eq!(res, Err(Ok(ProxyError::ThresholdNotMet)));
    }

    #[test]
    fn test_execute_rejected_before_timelock() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (client, signers) = setup(&env, 2, 100);
        client.propose_upgrade(&signers.get(0).unwrap(), &dummy_hash(&env));
        client.approve_upgrade(&signers.get(1).unwrap());
        // Still before unlock timestamp (1_100).
        set_time(&env, 1_050);
        let res = client.try_execute_upgrade();
        assert_eq!(res, Err(Ok(ProxyError::TimelockNotElapsed)));
    }

    #[test]
    fn test_execute_without_pending_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _signers) = setup(&env, 2, 100);
        let res = client.try_execute_upgrade();
        assert_eq!(res, Err(Ok(ProxyError::NoPendingUpgrade)));
    }

    #[test]
    fn test_non_signer_cannot_propose() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _signers) = setup(&env, 2, 100);
        let outsider = Address::generate(&env);
        let res = client.try_propose_upgrade(&outsider, &dummy_hash(&env));
        assert_eq!(res, Err(Ok(ProxyError::NotASigner)));
    }

    #[test]
    fn test_cancel_upgrade() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (client, signers) = setup(&env, 2, 100);
        client.propose_upgrade(&signers.get(0).unwrap(), &dummy_hash(&env));
        let admin = client.get_admin();
        client.cancel_upgrade(&admin);
        assert!(client.get_pending_upgrade().is_none());
    }

    /// Verifies that instance and persistent storage survive an upgrade by
    /// simulating the state-preservation guarantee: we re-read config and
    /// signer state after a successful execute_upgrade path (the actual WASM
    /// swap is a no-op in the test host, but storage keys are unchanged).
    #[test]
    fn test_storage_preserved_across_upgrade() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 1_000);
        let (client, signers) = setup(&env, 2, 100);

        let admin_before = client.get_admin();
        let threshold_before = client.get_threshold();
        let timelock_before = client.get_timelock();
        let signers_before = client.get_signers();

        client.propose_upgrade(&signers.get(0).unwrap(), &dummy_hash(&env));
        client.approve_upgrade(&signers.get(1).unwrap());
        set_time(&env, 1_100);
        client.execute_upgrade();

        // Pending upgrade cleared, but all config and signer state preserved.
        assert!(client.get_pending_upgrade().is_none());
        assert_eq!(client.get_admin(), admin_before);
        assert_eq!(client.get_threshold(), threshold_before);
        assert_eq!(client.get_timelock(), timelock_before);
        assert_eq!(client.get_signers(), signers_before);
    }
}