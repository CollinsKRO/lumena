[package]
name = "escrow"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
soroban-sdk = { version = "21.0.0" }

[dev-dependencies]
soroban-sdk = { version = "21.0.0", features = ["testutils"] }

[features]
testutils = ["soroban-sdk/testutils"]
```

```rust
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Env,
};

/// Storage keys for the escrow contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Maps an escrow id to its Escrow record.
    Escrow(u64),
    /// Monotonic counter for escrow ids.
    NextId,
}

/// Lifecycle state of an escrow.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EscrowState {
    Deposited,
    Released,
    Refunded,
    Disputed,
}

/// A single escrow record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub depositor: Address,
    pub recipient: Address,
    pub arbiter: Address,
    pub token: Address,
    pub amount: i128,
    pub deadline: u64,
    pub state: EscrowState,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    InvalidAmount = 2,
    InvalidDeadline = 3,
    InvalidState = 4,
    NotExpired = 5,
    Unauthorized = 6,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Create a new escrow, transferring `amount` of `token` from `depositor`
    /// into the contract. Returns the escrow id.
    ///
    /// `token` may be the native XLM Stellar asset contract address or any
    /// SEP-41 token address.
    pub fn deposit(
        env: Env,
        depositor: Address,
        recipient: Address,
        arbiter: Address,
        token: Address,
        amount: i128,
        deadline: u64,
    ) -> Result<u64, Error> {
        depositor.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if deadline <= env.ledger().timestamp() {
            return Err(Error::InvalidDeadline);
        }

        // Move funds into the contract.
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&depositor, &env.current_contract_address(), &amount);

        let id = Self::next_id(&env);
        let escrow = Escrow {
            depositor,
            recipient,
            arbiter,
            token,
            amount,
            deadline,
            state: EscrowState::Deposited,
        };
        env.storage().persistent().set(&DataKey::Escrow(id), &escrow);

        Ok(id)
    }

    /// Release escrowed funds to the recipient. Callable by the recipient or
    /// the arbiter while the escrow is in the Deposited state.
    pub fn release(env: Env, id: u64, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let mut escrow = Self::load(&env, id)?;
        if escrow.state != EscrowState::Deposited {
            return Err(Error::InvalidState);
        }
        if caller != escrow.recipient && caller != escrow.arbiter {
            return Err(Error::Unauthorized);
        }

        escrow.state = EscrowState::Released;
        env.storage().persistent().set(&DataKey::Escrow(id), &escrow);

        let token_client = token::Client::new(&env, &escrow.token);
        token_client.transfer(
            &env.current_contract_address(),
            &escrow.recipient,
            &escrow.amount,
        );

        Ok(())
    }

    /// Refund escrowed funds to the depositor. Callable by the depositor at any
    /// time, or by anyone once the deadline has passed.
    pub fn refund(env: Env, id: u64, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let mut escrow = Self::load(&env, id)?;
        if escrow.state != EscrowState::Deposited && escrow.state != EscrowState::Disputed {
            return Err(Error::InvalidState);
        }

        let expired = env.ledger().timestamp() >= escrow.deadline;
        if caller != escrow.depositor && !expired {
            return Err(Error::NotExpired);
        }

        escrow.state = EscrowState::Refunded;
        env.storage().persistent().set(&DataKey::Escrow(id), &escrow);

        let token_client = token::Client::new(&env, &escrow.token);
        token_client.transfer(
            &env.current_contract_address(),
            &escrow.depositor,
            &escrow.amount,
        );

        Ok(())
    }

    /// Raise a dispute on a deposited escrow. Callable by the depositor or the
    /// recipient.
    pub fn raise_dispute(env: Env, id: u64, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let mut escrow = Self::load(&env, id)?;
        if escrow.state != EscrowState::Deposited {
            return Err(Error::InvalidState);
        }
        if caller != escrow.depositor && caller != escrow.recipient {
            return Err(Error::Unauthorized);
        }

        escrow.state = EscrowState::Disputed;
        env.storage().persistent().set(&DataKey::Escrow(id), &escrow);

        Ok(())
    }

    /// Resolve a disputed escrow. The arbiter decides whether funds go to the
    /// recipient (`release_to_recipient = true`) or back to the depositor.
    pub fn arbitrate(
        env: Env,
        id: u64,
        caller: Address,
        release_to_recipient: bool,
    ) -> Result<(), Error> {
        caller.require_auth();

        let mut escrow = Self::load(&env, id)?;
        if escrow.state != EscrowState::Disputed {
            return Err(Error::InvalidState);
        }
        if caller != escrow.arbiter {
            return Err(Error::Unauthorized);
        }

        let token_client = token::Client::new(&env, &escrow.token);
        if release_to_recipient {
            escrow.state = EscrowState::Released;
            env.storage().persistent().set(&DataKey::Escrow(id), &escrow);
            token_client.transfer(
                &env.current_contract_address(),
                &escrow.recipient,
                &escrow.amount,
            );
        } else {
            escrow.state = EscrowState::Refunded;
            env.storage().persistent().set(&DataKey::Escrow(id), &escrow);
            token_client.transfer(
                &env.current_contract_address(),
                &escrow.depositor,
                &escrow.amount,
            );
        }

        Ok(())
    }

    /// Read an escrow record.
    pub fn get_escrow(env: Env, id: u64) -> Result<Escrow, Error> {
        Self::load(&env, id)
    }

    fn next_id(env: &Env) -> u64 {
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .unwrap_or(0);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        id
    }

    fn load(env: &Env, id: u64) -> Result<Escrow, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(id))
            .ok_or(Error::NotFound)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{token, Env};

    fn setup_token(env: &Env, admin: &Address) -> (Address, token::StellarAssetClient<'_>) {
        let contract = env.register_stellar_asset_contract_v2(admin.clone());
        let address = contract.address();
        let client = token::StellarAssetClient::new(env, &address);
        (address, client)
    }

    fn setup() -> (
        Env,
        EscrowContractClient<'static>,
        Address,
        Address,
        Address,
        Address,
        token::StellarAssetClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);

        let (token_addr, token_admin) = setup_token(&env, &admin);
        token_admin.mint(&depositor, &1_000);

        (env, client, depositor, recipient, arbiter, token_addr, token_admin)
    }

    #[test]
    fn test_deposit_locks_funds() {
        let (env, client, depositor, recipient, arbiter, token_addr, _) = setup();
        let token_client = token::Client::new(&env, &token_addr);

        let id = client.deposit(&depositor, &recipient, &arbiter, &token_addr, &500, &1000);
        assert_eq!(id, 0);
        assert_eq!(token_client.balance(&depositor), 500);
        assert_eq!(token_client.balance(&client.address), 500);

        let escrow = client.get_escrow(&id);
        assert_eq!(escrow.state, EscrowState::Deposited);
        assert_eq!(escrow.amount, 500);
    }

    #[test]
    fn test_release_by_recipient() {
        let (env, client, depositor, recipient, arbiter, token_addr, _) = setup();
        let token_client = token::Client::new(&env, &token_addr);

        let id = client.deposit(&depositor, &recipient, &arbiter, &token_addr, &500, &1000);
        client.release(&id, &recipient);

        assert_eq!(token_client.balance(&recipient), 500);
        assert_eq!(token_client.balance(&client.address), 0);
        assert_eq!(client.get_escrow(&id).state, EscrowState::Released);
    }

    #[test]
    fn test_release_by_arbiter() {
        let (env, client, depositor, recipient, arbiter, token_addr, _) = setup();
        let token_client = token::Client::new(&env, &token_addr);

        let id = client.deposit(&depositor, &recipient, &arbiter, &token_addr, &500, &1000);
        client.release(&id, &arbiter);

        assert_eq!(token_client.balance(&recipient), 500);
    }

    #[test]
    fn test_release_unauthorized() {
        let (env, client, depositor, recipient, arbiter, token_addr, _) = setup();
        let stranger = Address::generate(&env);

        let id = client.deposit(&depositor, &recipient, &arbiter, &token_addr, &500, &1000);
        let res = client.try_release(&id, &stranger);
        assert_eq!(res, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_refund_by_depositor() {
        let (env, client, depositor, recipient, arbiter, token_addr, _) = setup();
        let token_client = token::Client::new(&env, &token_addr);

        let id = client.deposit(&depositor, &recipient, &arbiter, &token_addr, &500, &1000);
        client.refund(&id, &depositor);

        assert_eq!(token_client.balance(&depositor), 1000);
        assert_eq!(client.get_escrow(&id).state, EscrowState::Refunded);
    }

    #[test]
    fn test_refund_after_expiry_by_anyone() {
        let (env, client, depositor, recipient, arbiter, token_addr, _) = setup();
        let token_client = token::Client::new(&env, &token_addr);
        let stranger = Address::generate(&env);

        let id = client.deposit(&depositor, &recipient, &arbiter, &token_addr, &500, &1000);

        // Before expiry, a stranger cannot refund.
        let res = client.try_refund(&id, &stranger);
        assert_eq!(res, Err(Ok(Error::NotExpired)));

        // Advance past the deadline.
        env.ledger().with_mut(|li| li.timestamp = 1000);
        client.refund(&id, &stranger);

        assert_eq!(token_client.balance(&depositor), 1000);
        assert_eq!(client.get_escrow(&id).state, EscrowState::Refunded);
    }

    #[test]
    fn test_dispute_and_arbitrate_to_recipient() {
        let (env, client, depositor, recipient, arbiter, token_addr, _) = setup();
        let token_client = token::Client::new(&env, &token_addr);

        let id = client.deposit(&depositor, &recipient, &arbiter, &token_addr, &500, &1000);
        client.raise_dispute(&id, &recipient);
        assert_eq!(client.get_escrow(&id).state, EscrowState::Disputed);

        client.arbitrate(&id, &arbiter, &true);
        assert_eq!(token_client.balance(&recipient), 500);
        assert_eq!(client.get_escrow(&id).state, EscrowState::Released);
    }

    #[test]
    fn test_dispute_and_arbitrate_to_depositor() {
        let (env, client, depositor, recipient, arbiter, token_addr, _) = setup();
        let token_client = token::Client::new(&env, &token_addr);

        let id = client.deposit(&depositor, &recipient, &arbiter, &token_addr, &500, &1000);
        client.raise_dispute(&id, &depositor);
        client.arbitrate(&id, &arbiter, &false);

        assert_eq!(token_client.balance(&depositor), 1000);
        assert_eq!(client.get_escrow(&id).state, EscrowState::Refunded);
    }

    #[test]
    fn test_arbitrate_unauthorized() {
        let (env, client, depositor, recipient, arbiter, token_addr, _) = setup();
        let stranger = Address::generate(&env);

        let id = client.deposit(&depositor, &recipient, &arbiter, &token_addr, &500, &1000);
        client.raise_dispute(&id, &depositor);
        let res = client.try_arbitrate(&id, &stranger, &true);
        assert_eq!(res, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_invalid_amount() {
        let (env, client, depositor, recipient, arbiter, token_addr, _) = setup();
        let res = client.try_deposit(&depositor, &recipient, &arbiter, &token_addr, &0, &1000);
        assert_eq!(res, Err(Ok(Error::InvalidAmount)));
    }

    #[test]
    fn test_invalid_deadline() {
        let (env, client, depositor, recipient, arbiter, token_addr, _) = setup();
        env.ledger().with_mut(|li| li.timestamp = 100);
        let res = client.try_deposit(&depositor, &recipient, &arbiter, &token_addr, &500, &100);
        assert_eq!(res, Err(Ok(Error::InvalidDeadline)));
    }
}