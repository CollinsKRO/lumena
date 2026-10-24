#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol,
};

}
/// Storage keys for the contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin address.
    Admin,
    /// Oracle contract address.
    Oracle,
    /// Maximum acceptable age (in seconds) for a price feed.
    MaxAge,
    /// Per-asset spend limit expressed in USD (7-decimal fixed point).
    Limit(Address),
    /// Per-asset price entry stored by the mock oracle.
    Price(Address),
}

/// A price entry stored by the oracle: USD price (7-decimal fixed point) and
/// the ledger timestamp at which it was recorded.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceEntry {
    pub price: i128,
    pub timestamp: u64,
}

/// Errors returned by the contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The oracle price is older than the configured max age.
    StalePrice = 1,
    /// No price is available for the requested asset.
    MissingPrice = 2,
    /// The requested amount exceeds the configured USD spend limit.
    SpendLimitExceeded = 3,
    /// Arithmetic overflow while computing USD value.
    Overflow = 4,
    /// The oracle has not been configured.
    OracleNotSet = 5,
    /// The amount must be positive.
    InvalidAmount = 6,
}

/// Number of decimals used for USD fixed-point values.
pub const USD_DECIMALS: u32 = 7;
/// Scaling factor for USD fixed-point values (10^7).
pub const USD_SCALE: i128 = 10_000_000;

/// Trait describing an oracle price-feed client.
///
/// Implementations are responsible for returning a `PriceEntry` for the given
/// asset, or `None` if no price is available.
pub trait OracleClient {
    /// Fetch the latest price entry for `asset`.
    fn get_price(env: &Env, asset: &Address) -> Option<PriceEntry>;
}

/// Mock oracle client that reads prices from contract storage.
///
/// This is used both as the default on-chain oracle for the contract and as a
/// test double. Prices are stored under `DataKey::Price(asset)`.
pub struct MockOracle;

impl OracleClient for MockOracle {
    fn get_price(env: &Env, asset: &Address) -> Option<PriceEntry> {
        env.storage()
            .persistent()
            .get(&DataKey::Price(asset.clone()))
    }
}

#[contract]
pub struct OracleSpendLimitContract;

#[contractimpl]
impl OracleSpendLimitContract {
    /// Initialize the contract with the oracle address and max acceptable
    /// price age (in seconds).
    pub fn initialize(env: Env, admin: Address, oracle: Address, max_age: u64) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        env.storage().instance().set(&DataKey::MaxAge, &max_age);
    }

    /// Return the configured oracle address.
    pub fn oracle(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Oracle)
            .expect("oracle not set")
    }

    /// Return the configured max age.
    pub fn max_age(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::MaxAge).unwrap_or(0)
    }

    /// Set the USD spend limit for `asset` (7-decimal fixed point).
    pub fn set_limit(env: Env, asset: Address, limit_usd: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::Limit(asset), &limit_usd);
    }

    /// Return the configured USD spend limit for `asset`, if any.
    pub fn get_limit(env: Env, asset: Address) -> Option<i128> {
        env.storage().persistent().get(&DataKey::Limit(asset))
    }

    /// Store a price for `asset` in the mock oracle. Records the current
    /// ledger timestamp.
    pub fn set_price(env: Env, asset: Address, price: i128) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin not set");
        admin.require_auth();
        let entry = PriceEntry {
            price,
            timestamp: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::Price(asset), &entry);
    }

    /// Store a price for `asset` with an explicit timestamp. Useful for tests
    /// that need to simulate stale prices.
    pub fn set_price_at(env: Env, asset: Address, price: i128, timestamp: u64) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin not set");
        admin.require_auth();
        let entry = PriceEntry { price, timestamp };
        env.storage()
            .persistent()
            .set(&DataKey::Price(asset), &entry);
    }

    /// Fetch the price entry for `asset` from the configured oracle.
    fn fetch_price(env: &Env, asset: &Address) -> Result<PriceEntry, Error> {
        if !env.storage().instance().has(&DataKey::Oracle) {
            return Err(Error::OracleNotSet);
        }
        MockOracle::get_price(env, asset).ok_or(Error::MissingPrice)
    }

    /// Compute the USD value of `amount` of `asset` using the oracle price.
    ///
    /// `amount` is expressed in the asset's smallest unit (assumed 7 decimals,
    /// matching the USD scale). The result is a USD value in 7-decimal fixed
    /// point.
    pub fn usd_value(env: Env, asset: Address, amount: i128) -> Result<i128, Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let entry = Self::fetch_price(&env, &asset)?;
        Self::validate_freshness(&env, &entry)?;
        Self::compute_usd(amount, entry.price)
    }

    /// Check whether spending `amount` of `asset` is allowed under the
    /// configured USD limit.
    ///
    /// Returns the computed USD value on success. Fails with `StalePrice` if
    /// the oracle price is too old, `MissingPrice` if no price is available,
    /// and `SpendLimitExceeded` if the USD value exceeds the configured limit.
    pub fn check_spend(env: Env, asset: Address, amount: i128) -> Result<i128, Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let entry = Self::fetch_price(&env, &asset)?;
        Self::validate_freshness(&env, &entry)?;

        let usd_value = Self::compute_usd(amount, entry.price)?;

        let limit: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Limit(asset.clone()))
            .unwrap_or(0);

        if usd_value > limit {
            return Err(Error::SpendLimitExceeded);
        }

        env.events()
            .publish((symbol_short!("spend_ok"), asset), (amount, usd_value));

        Ok(usd_value)
    }

    /// Validate that the price entry is not older than the configured max age.
    fn validate_freshness(env: &Env, entry: &PriceEntry) -> Result<(), Error> {
        let max_age: u64 = env.storage().instance().get(&DataKey::MaxAge).unwrap_or(0);
        let now = env.ledger().timestamp();

        // Guard against future-dated prices and stale prices.
        if entry.timestamp > now {
            return Err(Error::StalePrice);
        }
        if now.saturating_sub(entry.timestamp) > max_age {
            return Err(Error::StalePrice);
        }
        Ok(())
    }

    /// Compute USD value = amount * price / USD_SCALE using checked math.
    fn compute_usd(amount: i128, price: i128) -> Result<i128, Error> {
        if price <= 0 {
            return Err(Error::MissingPrice);
        }
        amount
            .checked_mul(price)
            .ok_or(Error::Overflow)
            .map(|v| v / USD_SCALE)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{Address, Env};

    fn setup(env: &Env, max_age: u64) -> (OracleSpendLimitContractClient<'_>, Address, Address) {
        let contract_id = env.register_contract(None, OracleSpendLimitContract);
        let client = OracleSpendLimitContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let oracle = Address::generate(env);
        client.initialize(&admin, &oracle, &max_age);
        (client, admin, oracle)
    }

    #[test]
    fn test_correct_conversion() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let (client, _admin, _oracle) = setup(&env, 60);
        let asset = Address::generate(&env);

        // Price: 0.5 USD per token, expressed as 5_000_000 (7 decimals).
        client.set_price(&asset, &5_000_000);
        // Limit: 100 USD.
        client.set_limit(&asset, &(100 * USD_SCALE));

        // 10 tokens (10 * 10^7) at 0.5 USD => 5 USD.
        let amount = 10 * USD_SCALE;
        let usd = client.check_spend(&asset, &amount);
        assert_eq!(usd, 5 * USD_SCALE);

        // usd_value should match.
        let usd2 = client.usd_value(&asset, &amount);
        assert_eq!(usd2, 5 * USD_SCALE);
    }

    #[test]
    fn test_spend_limit_exceeded() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let (client, _admin, _oracle) = setup(&env, 60);
        let asset = Address::generate(&env);

        // Price: 2 USD per token.
        client.set_price(&asset, &(2 * USD_SCALE));
        // Limit: 10 USD.
        client.set_limit(&asset, &(10 * USD_SCALE));

        // 10 tokens at 2 USD => 20 USD > 10 USD limit.
        let amount = 10 * USD_SCALE;
        let result = client.try_check_spend(&asset, &amount);
        assert_eq!(result, Err(Ok(Error::SpendLimitExceeded)));
    }

    #[test]
    fn test_stale_price_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let (client, _admin, _oracle) = setup(&env, 60);
        let asset = Address::generate(&env);

        // Price recorded at t=100, now t=1000 => age 900 > max_age 60.
        client.set_price_at(&asset, &USD_SCALE, &100);
        client.set_limit(&asset, &(100 * USD_SCALE));

        let result = client.try_check_spend(&asset, &USD_SCALE);
        assert_eq!(result, Err(Ok(Error::StalePrice)));

        let result2 = client.try_usd_value(&asset, &USD_SCALE);
        assert_eq!(result2, Err(Ok(Error::StalePrice)));
    }

    #[test]
    fn test_missing_price_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let (client, _admin, _oracle) = setup(&env, 60);
        let asset = Address::generate(&env);
        client.set_limit(&asset, &(100 * USD_SCALE));

        // No price set for asset.
        let result = client.try_check_spend(&asset, &USD_SCALE);
        assert_eq!(result, Err(Ok(Error::MissingPrice)));

        let result2 = client.try_usd_value(&asset, &USD_SCALE);
        assert_eq!(result2, Err(Ok(Error::MissingPrice)));
    }

    #[test]
    fn test_fresh_price_accepted() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let (client, _admin, _oracle) = setup(&env, 60);
        let asset = Address::generate(&env);

        // Price recorded at t=950, now t=1000 => age 50 <= max_age 60.
        client.set_price_at(&asset, &USD_SCALE, &950);
        client.set_limit(&asset, &(100 * USD_SCALE));

        let usd = client.check_spend(&asset, &USD_SCALE);
        assert_eq!(usd, USD_SCALE);
    }

    #[test]
    fn test_invalid_amount() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);

        let (client, _admin, _oracle) = setup(&env, 60);
        let asset = Address::generate(&env);
        client.set_price(&asset, &USD_SCALE);
        client.set_limit(&asset, &(100 * USD_SCALE));

        let result = client.try_check_spend(&asset, &0);
        assert_eq!(result, Err(Ok(Error::InvalidAmount)));

        let result2 = client.try_check_spend(&asset, &-1);
        assert_eq!(result2, Err(Ok(Error::InvalidAmount)));
    }

    #[test]
    #[should_panic]
    fn test_unauthorized_price_update_rejected() {
        let env = Env::default();
        env.ledger().set_timestamp(1_000);

        let (client, _admin, _oracle) = setup(&env, 60);
        let asset = Address::generate(&env);

        // Without mock_all_auths, calling set_price without admin auth should fail.
        client.set_price(&asset, &USD_SCALE);
}
}