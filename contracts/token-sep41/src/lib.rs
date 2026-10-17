#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, String, Symbol,
};

const DAY_IN_LEDGERS: u32 = 17280;
const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

const BALANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const BALANCE_LIFETIME_THRESHOLD: u32 = BALANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

const ALLOWANCE_BUMP_AMOUNT: u32 = 7 * DAY_IN_LEDGERS;
const ALLOWANCE_LIFETIME_THRESHOLD: u32 = ALLOWANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Decimals,
    Name,
    Symbol,
    TotalSupply,
    Balance(Address),
    Allowance(AllowanceKey),
    Authorized(Address),
}

#[derive(Clone)]
#[contracttype]
pub struct AllowanceKey {
    pub from: Address,
    pub spender: Address,
}

#[derive(Clone)]
#[contracttype]
pub struct AllowanceValue {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TokenError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InsufficientBalance = 4,
    InsufficientAllowance = 5,
    AllowanceExpired = 6,
    InvalidAmount = 7,
    NegativeNotAllowed = 8,
}

#[contract]
pub struct Sep41Token;

#[contractimpl]
impl Sep41Token {
    /// Initializes the token with an admin, decimals, name, and symbol.
    pub fn initialize(env: Env, admin: Address, decimals: u32, name: String, symbol: String) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, TokenError::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
        env.storage().instance().set(&DataKey::TotalSupply, &0_i128);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    /// Returns the token balance of `id`.
    pub fn balance(env: Env, id: Address) -> i128 {
        Self::read_balance(&env, &id)
    }

    /// Returns the spendable balance of `id` (same as balance for this token).
    pub fn spendable_balance(env: Env, id: Address) -> i128 {
        Self::read_balance(&env, &id)
    }

    /// Returns whether `id` is authorized to hold and transfer tokens.
    pub fn authorized(env: Env, id: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Authorized(id))
            .unwrap_or(true)
    }

    /// Transfers `amount` tokens from `from` to `to`.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        Self::do_transfer(&env, &from, &to, amount);
    }

    /// Transfers `amount` tokens from `from` to `to` using the spender's allowance.
    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        Self::spend_allowance(&env, &from, &spender, amount);
        Self::do_transfer(&env, &from, &to, amount);
    }

    /// Burns `amount` tokens from `from`.
    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        Self::do_burn(&env, &from, amount);
    }

    /// Burns `amount` tokens from `from` using the spender's allowance.
    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        Self::spend_allowance(&env, &from, &spender, amount);
        Self::do_burn(&env, &from, amount);
    }

    /// Returns the number of decimals used by the token.
    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Decimals)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::NotInitialized))
    }

    /// Returns the token name.
    pub fn name(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Name)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::NotInitialized))
    }

    /// Returns the token symbol.
    pub fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::NotInitialized))
    }

    /// Returns the total supply of tokens.
    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    /// Returns the allowance `spender` has from `from`.
    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        Self::read_allowance(&env, &from, &spender)
    }

    /// Sets the allowance `spender` has from `from` to `amount` until `expiration_ledger`.
    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        from.require_auth();
        if amount < 0 {
            panic_with_error!(&env, TokenError::NegativeNotAllowed);
        }
        if expiration_ledger < env.ledger().sequence() {
            panic_with_error!(&env, TokenError::AllowanceExpired);
        }
        Self::write_allowance(&env, &from, &spender, amount, expiration_ledger);
    }

    /// Mints `amount` tokens to `to`. Only the admin can mint.
    pub fn mint(env: Env, to: Address, amount: i128) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::NotInitialized));
        admin.require_auth();

        if amount < 0 {
            panic_with_error!(&env, TokenError::NegativeNotAllowed);
        }

        let total = Self::total_supply(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(total + amount));

        let balance = Self::read_balance(&env, &to);
        Self::write_balance(&env, &to, balance + amount);

        env.events()
            .publish((symbol_short!("mint"), admin, to), amount);
    }

    /// Sets the authorization status of `id`. Only the admin can call this.
    pub fn set_authorized(env: Env, id: Address, authorize: bool) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::NotInitialized));
        admin.require_auth();

        if authorize {
            env.storage().persistent().remove(&DataKey::Authorized(id.clone()));
        } else {
            env.storage()
                .persistent()
                .set(&DataKey::Authorized(id.clone()), &false);
        }

        env.events()
            .publish((symbol_short!("authorize"), admin, id), authorize);
    }

    /// Returns the admin address.
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::NotInitialized))
    }

    // --- Internal helpers ---

    fn read_balance(env: &Env, id: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(id.clone()))
            .unwrap_or(0)
    }

    fn write_balance(env: &Env, id: &Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::Balance(id.clone()), &amount);
        env.storage().persistent().extend_ttl(
            &DataKey::Balance(id.clone()),
            BALANCE_LIFETIME_THRESHOLD,
            BALANCE_BUMP_AMOUNT,
        );
    }

    fn read_allowance(env: &Env, from: &Address, spender: &Address) -> i128 {
        let key = DataKey::Allowance(AllowanceKey {
            from: from.clone(),
            spender: spender.clone(),
        });
        if let Some(allowance) = env
            .storage()
            .temporary()
            .get::<DataKey, AllowanceValue>(&key)
        {
            if allowance.expiration_ledger < env.ledger().sequence() {
                0
            } else {
                allowance.amount
            }
        } else {
            0
        }
    }

    fn write_allowance(
        env: &Env,
        from: &Address,
        spender: &Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        let key = DataKey::Allowance(AllowanceKey {
            from: from.clone(),
            spender: spender.clone(),
        });
        env.storage().temporary().set(
            &key,
            &AllowanceValue {
                amount,
                expiration_ledger,
            },
        );
        let live_for = expiration_ledger
            .checked_sub(env.ledger().sequence())
            .unwrap_or(0);
        env.storage().temporary().extend_ttl(
            &key,
            live_for,
            live_for,
        );
    }

    fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
        let key = DataKey::Allowance(AllowanceKey {
            from: from.clone(),
            spender: spender.clone(),
        });
        if let Some(allowance) = env
            .storage()
            .temporary()
            .get::<DataKey, AllowanceValue>(&key)
        {
            if allowance.expiration_ledger < env.ledger().sequence() {
                panic_with_error!(env, TokenError::AllowanceExpired);
            }
            if allowance.amount < amount {
                panic_with_error!(env, TokenError::InsufficientAllowance);
            }
            env.storage().temporary().set(
                &key,
                &AllowanceValue {
                    amount: allowance.amount - amount,
                    expiration_ledger: allowance.expiration_ledger,
                },
            );
        } else {
            panic_with_error!(env, TokenError::InsufficientAllowance);
        }
    }

    fn do_transfer(env: &Env, from: &Address, to: &Address, amount: i128) {
        if amount < 0 {
            panic_with_error!(env, TokenError::NegativeNotAllowed);
        }
        if !Self::authorized(env.clone(), from.clone()) {
            panic_with_error!(env, TokenError::Unauthorized);
        }
        if !Self::authorized(env.clone(), to.clone()) {
            panic_with_error!(env, TokenError::Unauthorized);
        }

        let from_balance = Self::read_balance(env, from);
        if from_balance < amount {
            panic_with_error!(env, TokenError::InsufficientBalance);
        }
        Self::write_balance(env, from, from_balance - amount);

        let to_balance = Self::read_balance(env, to);
        Self::write_balance(env, to, to_balance + amount);

        env.events()
            .publish((symbol_short!("transfer"), from.clone(), to.clone()), amount);
    }

    fn do_burn(env: &Env, from: &Address, amount: i128) {
        if amount < 0 {
            panic_with_error!(env, TokenError::NegativeNotAllowed);
        }
        if !Self::authorized(env.clone(), from.clone()) {
            panic_with_error!(env, TokenError::Unauthorized);
        }

        let from_balance = Self::read_balance(env, from);
        if from_balance < amount {
            panic_with_error!(env, TokenError::InsufficientBalance);
        }
        Self::write_balance(env, from, from_balance - amount);

        let total = Self::total_supply(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(total - amount));

        env.events()
            .publish((symbol_short!("burn"), from.clone()), amount);
    }
}

#[cfg(test)]
mod test;
```

```toml
[package]
name = "token-sep41"
version = "0.1.0"
edition = "2021"
publish = false

[lib]
crate-type = ["cdylib", "rlib"]

[features]
testutils = ["soroban-sdk/testutils"]

[dependencies]
soroban-sdk = { workspace = true }

[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }

[profile.release]
opt-level = "z"
overflow-checks = true
debug = 0
strip = "symbols"
debug-assertions = false
panic = "abort"
codegen-units = 1
lto = true
```

```rust
#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    Address, Env, String,
};

fn create_token<'a>(env: &Env, admin: &Address) -> Sep41TokenClient<'a> {
    let contract_id = env.register_contract(None, Sep41Token);
    let client = Sep41TokenClient::new(env, &contract_id);

    client.initialize(
        admin,
        &7,
        &String::from_str(env, "Lumen Token"),
        &String::from_str(env, "LMN"),
    );
    client
}

fn setup<'a>(env: &Env) -> (Address, Sep41TokenClient<'a>) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let client = create_token(env, &admin);
    (admin, client)
}

#[test]
fn test_initialize() {
    let env = Env::default();
    let (admin, client) = setup(&env);

    assert_eq!(client.decimals(), 7);
    assert_eq!(client.name(), String::from_str(&env, "Lumen Token"));
    assert_eq!(client.symbol(), String::from_str(&env, "LMN"));
    assert_eq!(client.admin(), admin);
    assert_eq!(client.total_supply(), 0);
}

#[test]
fn test_initialize_twice_fails() {
    let env = Env::default();
    let (admin, client) = setup(&env);
    let result = client.try_initialize(
        &admin,
        &7,
        &String::from_str(&env, "Lumen Token"),
        &String::from_str(&env, "LMN"),
    );
    assert!(result.is_err());
}

#[test]
fn test_mint_and_balance() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let user = Address::generate(&env);

    client.mint(&user, &1000);
    assert_eq!(client.balance(&user), 1000);
    assert_eq!(client.spendable_balance(&user), 1000);
    assert_eq!(client.total_supply(), 1000);

    client.mint(&user, &500);
    assert_eq!(client.balance(&user), 1500);
    assert_eq!(client.total_supply(), 1500);
}

#[test]
fn test_mint_negative_fails() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let user = Address::generate(&env);

    let result = client.try_mint(&user, &-1);
    assert!(result.is_err());
}

#[test]
fn test_transfer() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    client.mint(&from, &1000);
    client.transfer(&from, &to, &400);

    assert_eq!(client.balance(&from), 600);
    assert_eq!(client.balance(&to), 400);
    assert_eq!(client.total_supply(), 1000);
}

#[test]
fn test_transfer_insufficient_balance() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    client.mint(&from, &100);
    let result = client.try_transfer(&from, &to, &200);
    assert!(result.is_err());
}

#[test]
fn test_transfer_negative_fails() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    client.mint(&from, &100);
    let result = client.try_transfer(&from, &to, &-10);
    assert!(result.is_err());
}

#[test]
fn test_approve_and_transfer_from() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let to = Address::generate(&env);

    client.mint(&owner, &1000);
    client.approve(&owner, &spender, &500, &1000);

    assert_eq!(client.allowance(&owner, &spender), 500);

    client.transfer_from(&spender, &owner, &to, &200);

    assert_eq!(client.balance(&owner), 800);
    assert_eq!(client.balance(&to), 200);
    assert_eq!(client.allowance(&owner, &spender), 300);
}

#[test]
fn test_transfer_from_insufficient_allowance() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let to = Address::generate(&env);

    client.mint(&owner, &1000);
    client.approve(&owner, &spender, &100, &1000);

    let result = client.try_transfer_from(&spender, &owner, &to, &200);
    assert!(result.is_err());
}

#[test]
fn test_transfer_from_no_allowance() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let to = Address::generate(&env);

    client.mint(&owner, &1000);
    let result = client.try_transfer_from(&spender, &owner, &to, &100);
    assert!(result.is_err());
}

#[test]
fn test_allowance_exhaustion() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let to = Address::generate(&env);

    client.mint(&owner, &1000);
    client.approve(&owner, &spender, &100, &1000);

    client.transfer_from(&spender, &owner, &to, &100);
    assert_eq!(client.allowance(&owner, &spender), 0);

    let result = client.try_transfer_from(&spender, &owner, &to, &1);
    assert!(result.is_err());
}

#[test]
fn test_allowance_expiration() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let to = Address::generate(&env);

    client.mint(&owner, &1000);
    client.approve(&owner, &spender, &500, &10);

    env.ledger().set(LedgerInfo {
        timestamp: 0,
        protocol_version: 20,
        sequence_number: 20,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 10,
        min_persistent_entry_ttl: 10,
        max_entry_ttl: 1000,
    });

    assert_eq!(client.allowance(&owner, &spender), 0);
    let result = client.try_transfer_from(&spender, &owner, &to, &100);
    assert!(result.is_err());
}

#[test]
fn test_approve_negative_fails() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);

    let result = client.try_approve(&owner, &spender, &-1, &1000);
    assert!(result.is_err());
}

#[test]
fn test_burn() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let user = Address::generate(&env);

    client.mint(&user, &1000);
    client.burn(&user, &400);

    assert_eq!(client.balance(&user), 600);
    assert_eq!(client.total_supply(), 600);
}

#[test]
fn test_burn_insufficient_balance() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let user = Address::generate(&env);

    client.mint(&user, &100);
    let result = client.try_burn(&user, &200);
    assert!(result.is_err());
}

#[test]
fn test_burn_from() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);

    client.mint(&owner, &1000);
    client.approve(&owner, &spender, &500, &1000);

    client.burn_from(&spender, &owner, &300);

    assert_eq!(client.balance(&owner), 700);
    assert_eq!(client.allowance(&owner, &spender), 200);
    assert_eq!(client.total_supply(), 700);
}

#[test]
fn test_burn_from_insufficient_allowance() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);

    client.mint(&owner, &1000);
    client.approve(&owner, &spender, &100, &1000);

    let result = client.try_burn_from(&spender, &owner, &200);
    assert!(result.is_err());
}

#[test]
fn test_authorized_default_true() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let user = Address::generate(&env);

    assert!(client.authorized(&user));
}

#[test]
fn test_set_authorized_and_transfer_fails() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    client.mint(&from, &1000);
    client.set_authorized(&from, &false);
    assert!(!client.authorized(&from));

    let result = client.try_transfer(&from, &to, &100);
    assert!(result.is_err());

    client.set_authorized(&from, &true);
    assert!(client.authorized(&from));
    client.transfer(&from, &to, &100);
    assert_eq!(client.balance(&to), 100);
}

#[test]
fn test_set_authorized_recipient_fails() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    client.mint(&from, &1000);
    client.set_authorized(&to, &false);

    let result = client.try_transfer(&from, &to, &100);
    assert!(result.is_err());
}

#[test]
fn test_burn_unauthorized_fails() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let user = Address::generate(&env);

    client.mint(&user, &1000);
    client.set_authorized(&user, &false);

    let result = client.try_burn(&user, &100);
    assert!(result.is_err());
}

#[test]
fn test_zero_amount_transfer() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    client.mint(&from, &100);
    client.transfer(&from, &to, &0);
    assert_eq!(client.balance(&from), 100);
    assert_eq!(client.balance(&to), 0);
}