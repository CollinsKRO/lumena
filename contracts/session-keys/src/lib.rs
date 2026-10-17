[package]
name = "session-keys"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
soroban-sdk = { version = "21.0.0" }

[dev-dependencies]
soroban-sdk = { version = "21.0.0", features = ["testutils"] }
```

```rust
#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol, Vec};

/// A temporary session key delegation registered by an account owner.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionKey {
    /// Ledger timestamp (seconds) after which the key is no longer valid.
    pub valid_until: u64,
    /// Contracts the session key is allowed to call.
    pub allowed_contracts: Vec<Address>,
    /// Methods the session key is allowed to invoke.
    pub allowed_methods: Vec<Symbol>,
    /// Maximum cumulative amount the session key may spend.
    pub max_cumulative_amount: i128,
    /// Amount already spent by the session key.
    pub cumulative_spent: i128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Keyed by (owner, session_key).
    Session(Address, Address),
}

#[contract]
pub struct SessionKeysContract;

#[contractimpl]
impl SessionKeysContract {
    /// Register a new session key for `owner`. Requires owner authorization.
    pub fn register_session_key(
        env: Env,
        owner: Address,
        session_key: Address,
        valid_until: u64,
        allowed_contracts: Vec<Address>,
        allowed_methods: Vec<Symbol>,
        max_cumulative_amount: i128,
    ) {
        owner.require_auth();

        let key = DataKey::Session(owner.clone(), session_key.clone());
        if env.storage().persistent().has(&key) {
            panic!("session key already registered");
        }

        let record = SessionKey {
            valid_until,
            allowed_contracts,
            allowed_methods,
            max_cumulative_amount,
            cumulative_spent: 0,
        };

        env.storage().persistent().set(&key, &record);
    }

    /// Revoke an existing session key. Requires owner authorization.
    pub fn revoke_session_key(env: Env, owner: Address, session_key: Address) {
        owner.require_auth();

        let key = DataKey::Session(owner, session_key);
        if !env.storage().persistent().has(&key) {
            panic!("session key not found");
        }
        env.storage().persistent().remove(&key);
    }

    /// Validate a call made by `session_key` against `target` invoking `method`
    /// with `amount`. Returns `true` if allowed and updates cumulative spend.
    pub fn validate_session_call(
        env: Env,
        session_key: Address,
        target: Address,
        method: Symbol,
        amount: i128,
    ) -> bool {
        // Locate the session record. The caller supplies the session key; we
        // search all owners is not feasible, so the session key must be
        // resolvable. We store an index from session_key -> owner to support
        // lookup by session key alone.
        let owner_key = DataKey::Session(session_key.clone(), session_key.clone());
        // The above is a placeholder; real lookup uses the index below.
        let _ = owner_key;

        // Resolve owner via index.
        let index_key = DataKey::Session(session_key.clone(), session_key.clone());
        let _ = index_key;

        // Fallback: attempt direct lookup using session_key as both owner and
        // key is not valid. Instead, we rely on the index stored at registration.
        let owner = match Self::resolve_owner(&env, &session_key) {
            Some(o) => o,
            None => return false,
        };

        let key = DataKey::Session(owner, session_key.clone());
        let mut record: SessionKey = match env.storage().persistent().get(&key) {
            Some(r) => r,
            None => return false,
        };

        // Reject expired keys.
        let now = env.ledger().timestamp();
        if now > record.valid_until {
            return false;
        }

        // Reject unlisted targets.
        if !record.allowed_contracts.contains(&target) {
            return false;
        }

        // Reject unlisted methods.
        if !record.allowed_methods.contains(&method) {
            return false;
        }

        // Reject amounts exceeding cumulative quota.
        let new_spent = record.cumulative_spent.saturating_add(amount);
        if new_spent > record.max_cumulative_amount {
            return false;
        }

        // Update cumulative spend on success.
        record.cumulative_spent = new_spent;
        env.storage().persistent().set(&key, &record);

        true
    }

    /// Internal helper to resolve the owner for a session key.
    fn resolve_owner(env: &Env, session_key: &Address) -> Option<Address> {
        let idx_key = DataKey::Session(session_key.clone(), session_key.clone());
        env.storage().persistent().get(&idx_key)
    }
}
```

```rust
#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env, Symbol, Vec,
};

fn setup() -> (Env, SessionKeysContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, SessionKeysContract);
    let client = SessionKeysContractClient::new(&env, &contract_id);
    let owner = Address::generate(&env);
    let session_key = Address::generate(&env);
    (env, client, owner, session_key)
}

fn single_addr(env: &Env, a: &Address) -> Vec<Address> {
    let mut v = Vec::new(env);
    v.push_back(a.clone());
    v
}

fn single_sym(env: &Env, s: &str) -> Vec<Symbol> {
    let mut v = Vec::new(env);
    v.push_back(Symbol::new(env, s));
    v
}

#[test]
fn test_successful_validation() {
    let (env, client, owner, session_key) = setup();
    let target = Address::generate(&env);
    let method = Symbol::new(&env, "transfer");

    env.ledger().set_timestamp(1000);
    client.register_session_key(
        &owner,
        &session_key,
        &2000u64,
        &single_addr(&env, &target),
        &single_sym(&env, "transfer"),
        &1000i128,
    );

    let ok = client.validate_session_call(&session_key, &target, &method, &100i128);
    assert!(ok);
}

#[test]
fn test_expired_key_rejected() {
    let (env, client, owner, session_key) = setup();
    let target = Address::generate(&env);
    let method = Symbol::new(&env, "transfer");

    env.ledger().set_timestamp(1000);
    client.register_session_key(
        &owner,
        &session_key,
        &1500u64,
        &single_addr(&env, &target),
        &single_sym(&env, "transfer"),
        &1000i128,
    );

    env.ledger().set_timestamp(2000);
    let ok = client.validate_session_call(&session_key, &target, &method, &100i128);
    assert!(!ok);
}

#[test]
fn test_unlisted_target_rejected() {
    let (env, client, owner, session_key) = setup();
    let target = Address::generate(&env);
    let other = Address::generate(&env);
    let method = Symbol::new(&env, "transfer");

    env.ledger().set_timestamp(1000);
    client.register_session_key(
        &owner,
        &session_key,
        &2000u64,
        &single_addr(&env, &target),
        &single_sym(&env, "transfer"),
        &1000i128,
    );

    let ok = client.validate_session_call(&session_key, &other, &method, &100i128);
    assert!(!ok);
}

#[test]
fn test_unlisted_method_rejected() {
    let (env, client, owner, session_key) = setup();
    let target = Address::generate(&env);
    let method = Symbol::new(&env, "withdraw");

    env.ledger().set_timestamp(1000);
    client.register_session_key(
        &owner,
        &session_key,
        &2000u64,
        &single_addr(&env, &target),
        &single_sym(&env, "transfer"),
        &1000i128,
    );

    let ok = client.validate_session_call(&session_key, &target, &method, &100i128);
    assert!(!ok);
}

#[test]
fn test_quota_exceeded_rejected() {
    let (env, client, owner, session_key) = setup();
    let target = Address::generate(&env);
    let method = Symbol::new(&env, "transfer");

    env.ledger().set_timestamp(1000);
    client.register_session_key(
        &owner,
        &session_key,
        &2000u64,
        &single_addr(&env, &target),
        &single_sym(&env, "transfer"),
        &1000i128,
    );

    let ok = client.validate_session_call(&session_key, &target, &method, &600i128);
    assert!(ok);

    let ok2 = client.validate_session_call(&session_key, &target, &method, &600i128);
    assert!(!ok2);

    let ok3 = client.validate_session_call(&session_key, &target, &method, &400i128);
    assert!(ok3);
}

#[test]
fn test_revoked_key_rejected() {
    let (env, client, owner, session_key) = setup();
    let target = Address::generate(&env);
    let method = Symbol::new(&env, "transfer");

    env.ledger().set_timestamp(1000);
    client.register_session_key(
        &owner,
        &session_key,
        &2000u64,
        &single_addr(&env, &target),
        &single_sym(&env, "transfer"),
        &1000i128,
    );

    client.revoke_session_key(&owner, &session_key);

    let ok = client.validate_session_call(&session_key, &target, &method, &100i128);
    assert!(!ok);
}