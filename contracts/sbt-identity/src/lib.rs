#![no_std]

//! Non-transferable soulbound identity token (SBT) for KYC / policy attestation.
//!
//! Each wallet holds at most one credential. Credentials are minted and revoked
//! by authorized compliance issuers, exposed through the Soroban token
//! interface (`balance` is `1` while valid), and can never be transferred.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, String, Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    AlreadyIssued = 4,
    NotFound = 5,
    NonTransferable = 6,
    InvalidExpiry = 7,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Badge {
    pub issuer: Address,
    pub issued_at: u64,
    /// Ledger timestamp after which the badge is no longer valid; `0` never expires.
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Name,
    TokenSymbol,
    Issuer(Address),
    Badge(Address),
}

#[contract]
pub struct SbtIdentity;

#[contractimpl]
impl SbtIdentity {
    pub fn init(env: Env, admin: Address, name: String, symbol: String) -> Result<(), Error> {
        let storage = env.storage().instance();
        if storage.has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Name, &name);
        storage.set(&DataKey::TokenSymbol, &symbol);
        Ok(())
    }

    pub fn add_issuer(env: Env, issuer: Address) -> Result<(), Error> {
        Self::admin(&env)?.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::Issuer(issuer), &true);
        Ok(())
    }

    pub fn remove_issuer(env: Env, issuer: Address) -> Result<(), Error> {
        Self::admin(&env)?.require_auth();
        env.storage()
            .persistent()
            .remove(&DataKey::Issuer(issuer));
        Ok(())
    }

    pub fn is_issuer(env: Env, issuer: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Issuer(issuer))
    }

    pub fn mint(env: Env, issuer: Address, to: Address, expires_at: u64) -> Result<(), Error> {
        issuer.require_auth();
        if !Self::is_issuer(env.clone(), issuer.clone()) {
            return Err(Error::Unauthorized);
        }
        let now = env.ledger().timestamp();
        if expires_at != 0 && expires_at <= now {
            return Err(Error::InvalidExpiry);
        }
        if Self::is_valid(env.clone(), to.clone()) {
            return Err(Error::AlreadyIssued);
        }

        let badge = Badge {
            issuer: issuer.clone(),
            issued_at: now,
            expires_at,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Badge(to.clone()), &badge);

        event_schema::publish(
            &env,
            Symbol::new(&env, "sbt_identity"),
            Symbol::new(&env, "mint"),
            &to,
            (issuer, expires_at),
        );
        Ok(())
    }

    /// Revokes `owner`'s credential. Only the issuer that minted it may revoke it.
    pub fn revoke(env: Env, issuer: Address, owner: Address) -> Result<(), Error> {
        issuer.require_auth();
        let key = DataKey::Badge(owner.clone());
        let badge: Badge = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        if badge.issuer != issuer {
            return Err(Error::Unauthorized);
        }
        env.storage().persistent().remove(&key);

        event_schema::publish(
            &env,
            Symbol::new(&env, "sbt_identity"),
            Symbol::new(&env, "revoke"),
            &owner,
            issuer,
        );
        Ok(())
    }

    pub fn badge(env: Env, owner: Address) -> Option<Badge> {
        env.storage().persistent().get(&DataKey::Badge(owner))
    }

    /// Returns whether `owner` currently holds an unexpired, unrevoked credential.
    pub fn is_valid(env: Env, owner: Address) -> bool {
        match Self::badge(env.clone(), owner) {
            Some(badge) => badge.expires_at == 0 || env.ledger().timestamp() < badge.expires_at,
            None => false,
        }
    }

    // Soroban token interface. Balances reflect credential validity and every
    // movement of tokens between wallets is rejected.

    pub fn balance(env: Env, id: Address) -> i128 {
        if Self::is_valid(env, id) {
            1
        } else {
            0
        }
    }

    pub fn decimals(_env: Env) -> u32 {
        0
    }

    pub fn name(env: Env) -> String {
        env.storage().instance().get(&DataKey::Name).unwrap()
    }

    pub fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::TokenSymbol)
            .unwrap()
    }

    pub fn allowance(_env: Env, _from: Address, _spender: Address) -> i128 {
        0
    }

    pub fn approve(
        _env: Env,
        _from: Address,
        _spender: Address,
        _amount: i128,
        _expiration_ledger: u32,
    ) -> Result<(), Error> {
        Err(Error::NonTransferable)
    }

    pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) -> Result<(), Error> {
        Err(Error::NonTransferable)
    }

    pub fn transfer_from(
        _env: Env,
        _spender: Address,
        _from: Address,
        _to: Address,
        _amount: i128,
    ) -> Result<(), Error> {
        Err(Error::NonTransferable)
    }
}

impl SbtIdentity {
    fn admin(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test;
