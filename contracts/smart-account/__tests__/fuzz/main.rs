//! Property-based fuzz suite for the smart account's signer storage.
//!
//! Invariants checked on every run:
//! - total funds are conserved across the account and the recipient,
//! - transfers never execute without enough authorized signer weight,
//! - the contract never panics; every rejection is a typed contract error.

use proptest::prelude::*;
use smart_account::{SmartAccount, SmartAccountClient};
use soroban_sdk::{testutils::Address as _, token, Address, Env, Map};

const CASES: u32 = 10_000;
const BALANCE: i128 = 1_000_000;

fn signer_map(env: &Env, signers: &[(Address, u32)]) -> Map<Address, u32> {
    let mut map = Map::new(env);
    for (signer, weight) in signers {
        map.set(signer.clone(), *weight);
    }
    map
}

fn generate_signers(env: &Env, weights: &[u32]) -> Vec<(Address, u32)> {
    weights
        .iter()
        .map(|weight| (Address::generate(env), *weight))
        .collect()
}

/// Maps an arbitrary seed onto a threshold in `1..=total_weight`.
fn reachable_threshold(weights: &[u32], seed: u32) -> u32 {
    let total: u64 = weights.iter().map(|weight| *weight as u64).sum();
    (1 + seed as u64 % total).min(u32::MAX as u64) as u32
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(CASES))]

    #[test]
    fn init_never_panics_and_never_bricks(
        weights in prop::collection::vec(any::<u32>(), 0..8),
        threshold in any::<u32>(),
    ) {
        let env = Env::default();
        let account = SmartAccountClient::new(&env, &env.register(SmartAccount, ()));
        let signers = generate_signers(&env, &weights);
        let total: u64 = weights.iter().map(|weight| *weight as u64).sum();

        let result = account.try_init(&signer_map(&env, &signers), &threshold);

        prop_assert!(!matches!(result, Err(Err(_))), "init panicked");
        let expected_ok = !weights.contains(&0) && threshold > 0 && total >= threshold as u64;
        prop_assert_eq!(result.is_ok(), expected_ok);
        if expected_ok {
            prop_assert_eq!(account.threshold(), threshold);
            prop_assert_eq!(account.signers().len() as usize, weights.len());
        } else {
            prop_assert_eq!(account.threshold(), 0);
        }
    }

    #[test]
    fn transfer_conserves_funds_and_enforces_threshold(
        weights in prop::collection::vec(1u32..=u32::MAX, 1..6),
        threshold_seed in any::<u32>(),
        approver_mask in any::<u8>(),
        include_outsider in any::<bool>(),
        amount in any::<i128>().prop_map(|amount| amount % (BALANCE * 2)),
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let account_id = env.register(SmartAccount, ());
        let account = SmartAccountClient::new(&env, &account_id);
        let signers = generate_signers(&env, &weights);
        let threshold = reachable_threshold(&weights, threshold_seed);
        account.init(&signer_map(&env, &signers), &threshold);

        let token_id = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        token::StellarAssetClient::new(&env, &token_id).mint(&account_id, &BALANCE);
        let token = token::Client::new(&env, &token_id);
        let recipient = Address::generate(&env);

        let mut approvers = soroban_sdk::Vec::new(&env);
        let mut approved_weight: u64 = 0;
        for (i, (signer, weight)) in signers.iter().enumerate() {
            if approver_mask & (1 << i) != 0 {
                approvers.push_back(signer.clone());
                approved_weight += *weight as u64;
            }
        }
        if include_outsider {
            approvers.push_back(Address::generate(&env));
        }

        let result = account.try_transfer(&approvers, &token_id, &recipient, &amount);

        prop_assert!(!matches!(result, Err(Err(_))), "transfer panicked");
        prop_assert_eq!(token.balance(&account_id) + token.balance(&recipient), BALANCE);

        let authorized = !include_outsider && approved_weight >= threshold as u64;
        let expected_ok = authorized && amount > 0 && amount <= BALANCE;
        prop_assert_eq!(result.is_ok(), expected_ok);
        prop_assert_eq!(token.balance(&recipient), if expected_ok { amount } else { 0 });
    }

    #[test]
    fn transfer_without_signer_auth_never_executes(
        weights in prop::collection::vec(1u32..=u32::MAX, 1..6),
        threshold_seed in any::<u32>(),
        amount in 1..=BALANCE,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let account_id = env.register(SmartAccount, ());
        let account = SmartAccountClient::new(&env, &account_id);
        let signers = generate_signers(&env, &weights);
        account.init(
            &signer_map(&env, &signers),
            &reachable_threshold(&weights, threshold_seed),
        );

        let token_id = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        token::StellarAssetClient::new(&env, &token_id).mint(&account_id, &BALANCE);
        let token = token::Client::new(&env, &token_id);
        let recipient = Address::generate(&env);

        let mut approvers = soroban_sdk::Vec::new(&env);
        for (signer, _) in signers.iter() {
            approvers.push_back(signer.clone());
        }

        // Drop the mocked authorizations: every signer is listed, but none has signed.
        env.set_auths(&[]);
        let result = account.try_transfer(&approvers, &token_id, &recipient, &amount);

        prop_assert!(result.is_err());
        prop_assert_eq!(token.balance(&account_id), BALANCE);
        prop_assert_eq!(token.balance(&recipient), 0);
    }
}
