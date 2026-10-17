#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, BytesN, Env, Map,
};

/// Storage keys used by the policy-guard contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The admin authorized to mutate the registry.
    Admin,
    /// Persistent map of verified contract address -> wasm hash.
    Registry,
}

/// Typed errors returned by the policy-guard contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PolicyError {
    /// The caller is not the configured admin.
    Unauthorized = 1,
    /// The contract has not been initialized yet.
    NotInitialized = 2,
    /// The contract has already been initialized.
    AlreadyInitialized = 3,
    /// The target contract is not present in the verified registry.
    UnregisteredContract = 4,
    /// The provided wasm hash does not match the registered hash.
    HashMismatch = 5,
}

#[contract]
pub struct PolicyGuard;

#[contractimpl]
impl PolicyGuard {
    /// Initialize the contract with an admin address.
    ///
    /// Can only be called once.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, PolicyError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::Registry, &Map::<Address, BytesN<32>>::new(&env));
    }

    /// Register (or update) a verified contract with its wasm hash.
    ///
    /// Only the admin may call this. The target address is stored in the
    /// persistent registry map keyed by address.
    pub fn register(env: Env, target: Address, wasm_hash: BytesN<32>) {
        let admin = Self::read_admin(&env);
        admin.require_auth();

        let mut registry = Self::read_registry(&env);
        registry.set(target, wasm_hash);
        env.storage().persistent().set(&DataKey::Registry, &registry);
    }

    /// Remove a contract from the verified registry.
    ///
    /// Only the admin may call this.
    pub fn unregister(env: Env, target: Address) {
        let admin = Self::read_admin(&env);
        admin.require_auth();

        let mut registry = Self::read_registry(&env);
        registry.remove(target);
        env.storage().persistent().set(&DataKey::Registry, &registry);
    }

    /// Return the registered wasm hash for a target, if any.
    pub fn verify(env: Env, target: Address) -> Option<BytesN<32>> {
        Self::read_registry(&env).get(target)
    }

    /// Return `true` if the target is present in the verified registry.
    pub fn is_registered(env: Env, target: Address) -> bool {
        Self::read_registry(&env).contains_key(target)
    }

    /// Guard an invocation against `target`.
    ///
    /// Checks that the current contract address is initialized and that the
    /// target is present in the verified registry. Returns a typed
    /// `UnregisteredContract` error for unregistered targets. For registered
    /// targets the call passes through with no additional work.
    pub fn validate_invocation(env: Env, target: Address) -> Result<(), PolicyError> {
        // Ensure the guard itself is initialized before dispatching.
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(PolicyError::NotInitialized);
        }

        // Touch the current contract address so the guard is bound to the
        // executing contract instance.
        let _current = env.current_contract_address();

        // Fast path: registered targets pass through with no extra work.
        if Self::read_registry(&env).contains_key(target) {
            return Ok(());
        }

        Err(PolicyError::UnregisteredContract)
    }

    /// Guard an invocation against `target`, additionally verifying that the
    /// provided wasm hash matches the registered hash.
    pub fn validate_invocation_with_hash(
        env: Env,
        target: Address,
        wasm_hash: BytesN<32>,
    ) -> Result<(), PolicyError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(PolicyError::NotInitialized);
        }

        let _current = env.current_contract_address();

        match Self::read_registry(&env).get(target) {
            Some(registered) => {
                if registered == wasm_hash {
                    Ok(())
                } else {
                    Err(PolicyError::HashMismatch)
                }
            }
            None => Err(PolicyError::UnregisteredContract),
        }
    }

    /// Return the configured admin address.
    pub fn admin(env: Env) -> Address {
        Self::read_admin(&env)
    }

    fn read_admin(env: &Env) -> Address {
        match env.storage().instance().get(&DataKey::Admin) {
            Some(admin) => admin,
            None => panic_with_error!(env, PolicyError::NotInitialized),
        }
    }

    fn read_registry(env: &Env) -> Map<Address, BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::Registry)
            .unwrap_or_else(|| Map::new(env))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    fn setup() -> (Env, PolicyGuardClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, PolicyGuard);
        let client = PolicyGuardClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, client, admin)
    }

    fn hash(env: &Env, seed: u8) -> BytesN<32> {
        BytesN::from_array(env, &[seed; 32])
    }

    #[test]
    fn rejects_unregistered_target() {
        let (env, client, _admin) = setup();
        let target = Address::generate(&env);

        let result = client.try_validate_invocation(&target);
        assert_eq!(result, Err(Ok(PolicyError::UnregisteredContract)));
    }

    #[test]
    fn passes_through_registered_target() {
        let (env, client, _admin) = setup();
        let target = Address::generate(&env);

        client.register(&target, &hash(&env, 7));
        assert!(client.is_registered(&target));

        let result = client.try_validate_invocation(&target);
        assert_eq!(result, Ok(Ok(())));
    }

    #[test]
    fn register_and_verify_roundtrip() {
        let (env, client, _admin) = setup();
        let target = Address::generate(&env);
        let wasm_hash = hash(&env, 42);

        client.register(&target, &wasm_hash);
        assert_eq!(client.verify(&target), Some(wasm_hash));
    }

    #[test]
    fn unregister_removes_target() {
        let (env, client, _admin) = setup();
        let target = Address::generate(&env);

        client.register(&target, &hash(&env, 1));
        client.unregister(&target);

        assert!(!client.is_registered(&target));
        assert_eq!(client.verify(&target), None);

        let result = client.try_validate_invocation(&target);
        assert_eq!(result, Err(Ok(PolicyError::UnregisteredContract)));
    }

    #[test]
    fn validate_with_hash_matches() {
        let (env, client, _admin) = setup();
        let target = Address::generate(&env);
        let wasm_hash = hash(&env, 9);

        client.register(&target, &wasm_hash);
        let result = client.try_validate_invocation_with_hash(&target, &wasm_hash);
        assert_eq!(result, Ok(Ok(())));
    }

    #[test]
    fn validate_with_hash_mismatch() {
        let (env, client, _admin) = setup();
        let target = Address::generate(&env);

        client.register(&target, &hash(&env, 9));
        let result = client.try_validate_invocation_with_hash(&target, &hash(&env, 10));
        assert_eq!(result, Err(Ok(PolicyError::HashMismatch)));
    }

    #[test]
    fn validate_with_hash_unregistered() {
        let (env, client, _admin) = setup();
        let target = Address::generate(&env);

        let result = client.try_validate_invocation_with_hash(&target, &hash(&env, 3));
        assert_eq!(result, Err(Ok(PolicyError::UnregisteredContract)));
    }

    #[test]
    fn double_initialize_fails() {
        let (env, client, admin) = setup();
        let result = client.try_initialize(&admin);
        assert_eq!(result, Err(Ok(PolicyError::AlreadyInitialized)));
        let _ = env;
    }
}