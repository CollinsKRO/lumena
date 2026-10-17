#![no_std]

//! Standard event layout shared by every Lumen Soroban contract.
//!
//! Every event is published with exactly three topics:
//!
//! | Index | Name       | ScVal type   | Meaning                                   |
//! |-------|------------|--------------|-------------------------------------------|
//! | 0     | `contract` | `ScvSymbol`  | Emitting contract, e.g. `smart_account`   |
//! | 1     | `action`   | `ScvSymbol`  | Action that happened, e.g. `transfer`     |
//! | 2     | `wallet`   | `ScvAddress` | Wallet the event concerns                 |
//!
//! Payload schemas for each `(contract, action)` pair are listed in `README.md`.

use soroban_sdk::{Address, Env, IntoVal, Symbol, TryFromVal, Val, Vec};

/// Number of topics in a standard event.
pub const TOPIC_COUNT: u32 = 3;

/// Publishes `data` under the standard `[contract, action, wallet]` topics.
pub fn publish<D>(env: &Env, contract: Symbol, action: Symbol, wallet: &Address, data: D)
where
    D: IntoVal<Env, Val>,
{
    env.events()
        .publish((contract, action, wallet.clone()), data);
}

/// Decoded standard topics, as seen by an off-chain subscriber or indexer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventTopics {
    pub contract: Symbol,
    pub action: Symbol,
    pub wallet: Address,
}

impl EventTopics {
    /// Decodes raw event topics, returning `None` if they do not follow the standard.
    pub fn parse(env: &Env, topics: &Vec<Val>) -> Option<Self> {
        if topics.len() != TOPIC_COUNT {
            return None;
        }
        Some(Self {
            contract: Symbol::try_from_val(env, &topics.get(0)?).ok()?,
            action: Symbol::try_from_val(env, &topics.get(1)?).ok()?,
            wallet: Address::try_from_val(env, &topics.get(2)?).ok()?,
        })
    }
}

#[cfg(test)]
mod test;
