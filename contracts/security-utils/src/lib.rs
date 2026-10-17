Cargo.toml:
```toml
[package]
name = "security-utils"
version = "0.1.0"
edition = "2021"
description = "Reentrancy guard and invariant assertion utilities for Soroban contracts"
license = "Apache-2.0"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
soroban-sdk = { version = "21.0.0" }

[dev-dependencies]
soroban-sdk = { version = "21.0.0", features = ["testutils"] }

[features]
testutils = ["soroban-sdk/testutils"]
```

src/lib.rs:
```rust
#![no_std]

use soroban_sdk::{contracterror, contracttype, symbol_short, Env, Symbol};

/// Errors that can be produced by the security utilities.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    /// A reentrant call was detected while the guard was already held.
    ReentrancyDetected = 1,
    /// An invariant assertion failed.
    InvariantViolated = 2,
}

/// Storage key used to hold the reentrancy lock in temporary storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Lock(Symbol),
}

/// Default lock symbol used by the guard when no explicit key is provided.
pub fn default_lock_key() -> Symbol {
    symbol_short!("re_lock")
}

/// A reentrancy guard backed by temporary contract storage.
///
/// The lock is stored in temporary storage keyed by a [`Symbol`]. `enter`
/// sets the lock and returns [`ContractError::ReentrancyDetected`] if it is
/// already set. `exit` clears the lock.
pub trait ReentrancyGuard {
    /// Acquire the lock. Errors with `ReentrancyDetected` if already held.
    fn enter(env: &Env) -> Result<(), ContractError> {
        Self::enter_with_key(env, &default_lock_key())
    }

    /// Acquire the lock using an explicit key.
    fn enter_with_key(env: &Env, key: &Symbol) -> Result<(), ContractError> {
        let storage_key = DataKey::Lock(key.clone());
        if env.storage().temporary().has(&storage_key) {
            return Err(ContractError::ReentrancyDetected);
        }
        env.storage().temporary().set(&storage_key, &true);
        Ok(())
    }

    /// Release the lock.
    fn exit(env: &Env) {
        Self::exit_with_key(env, &default_lock_key())
    }

    /// Release the lock using an explicit key.
    fn exit_with_key(env: &Env, key: &Symbol) {
        let storage_key = DataKey::Lock(key.clone());
        env.storage().temporary().remove(&storage_key);
    }

    /// Returns true if the lock is currently held.
    fn is_locked(env: &Env) -> bool {
        Self::is_locked_with_key(env, &default_lock_key())
    }

    /// Returns true if the lock for the given key is currently held.
    fn is_locked_with_key(env: &Env, key: &Symbol) -> bool {
        let storage_key = DataKey::Lock(key.clone());
        env.storage().temporary().has(&storage_key)
    }
}

/// Assert that an invariant holds. Panics (via `InvariantViolated`) if not.
///
/// Intended to be called before and after external invocation blocks.
pub fn assert_invariant(condition: bool) {
    if !condition {
        panic_with_error_invariant();
    }
}

/// Assert that an invariant holds, returning a `Result` instead of panicking.
pub fn check_invariant(condition: bool) -> Result<(), ContractError> {
    if condition {
        Ok(())
    } else {
        Err(ContractError::InvariantViolated)
    }
}

fn panic_with_error_invariant() -> ! {
    // Soroban panics are surfaced as contract errors; use a dedicated panic
    // message so callers can distinguish invariant failures.
    panic!("InvariantViolated")
}

/// Wraps a function body with reentrancy guard `enter`/`exit` calls.
///
/// The wrapped function must be a method on a type implementing
/// [`ReentrancyGuard`] and must take `env: &Env` as its first argument.
///
/// ```ignore
/// #[reentrancy_guard]
/// pub fn transfer(env: Env, to: Address, amount: i128) -> Result<(), ContractError> {
///     // body
///     Ok(())
/// }
/// ```
#[macro_export]
macro_rules! reentrancy_guard {
    (
        $(#[$meta:meta])*
        $vis:vis fn $name:ident ( $env:ident : $env_ty:ty $(, $arg:ident : $arg_ty:ty)* $(,)? ) -> $ret:ty $body:block
    ) => {
        $(#[$meta])*
        $vis fn $name( $env: $env_ty $(, $arg: $arg_ty)* ) -> $ret {
            <Self as $crate::ReentrancyGuard>::enter(&$env)?;
            let __guard_result = (|| -> $ret $body)();
            <Self as $crate::ReentrancyGuard>::exit(&$env);
            __guard_result
        }
    };
    (
        $(#[$meta:meta])*
        $vis:vis fn $name:ident ( $env:ident : $env_ty:ty $(, $arg:ident : $arg_ty:ty)* $(,)? ) $body:block
    ) => {
        $(#[$meta])*
        $vis fn $name( $env: $env_ty $(, $arg: $arg_ty)* ) {
            <Self as $crate::ReentrancyGuard>::enter(&$env)
                .expect("ReentrancyDetected");
            (|| $body)();
            <Self as $crate::ReentrancyGuard>::exit(&$env);
        }
    };
}

#[cfg(test)]
mod test;
```

src/test.rs:
```rust
#![cfg(test)]

use super::*;
use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct TestContract;

#[contractimpl]
impl ReentrancyGuard for TestContract {}

#[contractimpl]
impl TestContract {
    /// Recursively invokes `recursive` on itself. The outer call acquires the
    /// lock; the inner call must fail with `ReentrancyDetected`.
    pub fn recursive(env: Env, depth: u32) -> Result<u32, ContractError> {
        <Self as ReentrancyGuard>::enter(&env)?;

        let result = if depth == 0 {
            Ok(0u32)
        } else {
            // Re-enter via a fresh invocation of the same contract.
            let client = TestContractClient::new(&env, &env.current_contract_address());
            match client.try_recursive(&(depth - 1)) {
                Ok(Ok(v)) => Ok(v),
                Ok(Err(e)) => Err(e),
                Err(_) => Err(ContractError::ReentrancyDetected),
            }
        };

        <Self as ReentrancyGuard>::exit(&env);
        result
    }

    /// Simple guarded function that returns a value.
    pub fn guarded_value(env: Env, value: u32) -> Result<u32, ContractError> {
        <Self as ReentrancyGuard>::enter(&env)?;
        let out = value + 1;
        <Self as ReentrancyGuard>::exit(&env);
        Ok(out)
    }

    /// Uses the macro to guard a function body.
    #[reentrancy_guard]
    pub fn macro_guarded(env: Env, value: u32) -> Result<u32, ContractError> {
        Ok(value * 2)
    }

    /// Invokes the guarded function twice in sequence to prove the lock is
    /// released after each call.
    pub fn sequential(env: Env) -> Result<u32, ContractError> {
        let a = Self::guarded_value(env.clone(), 1)?;
        let b = Self::guarded_value(env.clone(), 2)?;
        Ok(a + b)
    }
}

#[test]
fn test_enter_exit() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestContract);
    let client = TestContractClient::new(&env, &contract_id);

    let result = client.guarded_value(&5);
    assert_eq!(result, 6);
}

#[test]
fn test_sequential_calls_succeed() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestContract);
    let client = TestContractClient::new(&env, &contract_id);

    let result = client.sequential();
    assert_eq!(result, 5);
}

#[test]
fn test_macro_guarded() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestContract);
    let client = TestContractClient::new(&env, &contract_id);

    let result = client.macro_guarded(&21);
    assert_eq!(result, 42);
}

#[test]
fn test_recursive_call_detected() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestContract);
    let client = TestContractClient::new(&env, &contract_id);

    // Depth 1 triggers a recursive self-invocation; the inner call must fail
    // with ReentrancyDetected.
    let result = client.try_recursive(&1);
    match result {
        Ok(Err(e)) => assert_eq!(e, ContractError::ReentrancyDetected),
        Ok(Ok(_)) => panic!("expected reentrancy error, got success"),
        Err(_) => panic!("expected reentrancy error, got invocation failure"),
    }
}

#[test]
fn test_invariant_helpers() {
    assert!(check_invariant(true).is_ok());
    assert_eq!(
        check_invariant(false),
        Err(ContractError::InvariantViolated)
    );
    assert_invariant(true);
}

#[test]
#[should_panic]
fn test_assert_invariant_panics() {
    assert_invariant(false);
}