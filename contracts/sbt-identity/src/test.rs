use super::*;
use event_schema::EventTopics;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    Env,
};

struct Setup<'a> {
    env: Env,
    client: SbtIdentityClient<'a>,
    issuer: Address,
}

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let client = SbtIdentityClient::new(&env, &env.register(SbtIdentity, ()));
    let admin = Address::generate(&env);
    client.init(
        &admin,
        &String::from_str(&env, "Lumen KYC"),
        &String::from_str(&env, "LKYC"),
    );
    let issuer = Address::generate(&env);
    client.add_issuer(&issuer);

    Setup { env, client, issuer }
}

#[test]
fn issuer_mints_valid_badge() {
    let Setup { env, client, issuer } = setup();
    let owner = Address::generate(&env);

    client.mint(&issuer, &owner, &0);

    assert!(client.is_valid(&owner));
    assert_eq!(client.balance(&owner), 1);
    assert_eq!(client.badge(&owner).unwrap().issuer, issuer);
    assert_eq!(client.decimals(), 0);
}

#[test]
fn only_authorized_issuers_can_mint() {
    let Setup { env, client, .. } = setup();
    let outsider = Address::generate(&env);
    let owner = Address::generate(&env);

    assert_eq!(
        client.try_mint(&outsider, &owner, &0),
        Err(Ok(Error::Unauthorized))
    );
    assert!(!client.is_valid(&owner));
}

#[test]
fn removed_issuer_cannot_mint() {
    let Setup { env, client, issuer } = setup();
    client.remove_issuer(&issuer);

    assert_eq!(
        client.try_mint(&issuer, &Address::generate(&env), &0),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn cannot_mint_twice() {
    let Setup { env, client, issuer } = setup();
    let owner = Address::generate(&env);
    client.mint(&issuer, &owner, &0);

    assert_eq!(
        client.try_mint(&issuer, &owner, &0),
        Err(Ok(Error::AlreadyIssued))
    );
}

#[test]
fn badge_cannot_be_transferred() {
    let Setup { env, client, issuer } = setup();
    let owner = Address::generate(&env);
    let other = Address::generate(&env);
    client.mint(&issuer, &owner, &0);

    assert_eq!(
        client.try_transfer(&owner, &other, &1),
        Err(Ok(Error::NonTransferable))
    );
    assert_eq!(
        client.try_approve(&owner, &other, &1, &1000),
        Err(Ok(Error::NonTransferable))
    );
    assert_eq!(
        client.try_transfer_from(&other, &owner, &other, &1),
        Err(Ok(Error::NonTransferable))
    );
    assert_eq!(client.allowance(&owner, &other), 0);
    assert_eq!(client.balance(&owner), 1);
    assert_eq!(client.balance(&other), 0);
}

#[test]
fn issuer_can_revoke() {
    let Setup { env, client, issuer } = setup();
    let owner = Address::generate(&env);
    client.mint(&issuer, &owner, &0);

    client.revoke(&issuer, &owner);

    assert!(!client.is_valid(&owner));
    assert_eq!(client.balance(&owner), 0);
    assert_eq!(client.badge(&owner), None);
    assert_eq!(
        client.try_revoke(&issuer, &owner),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn only_minting_issuer_can_revoke() {
    let Setup { env, client, issuer } = setup();
    let owner = Address::generate(&env);
    let other_issuer = Address::generate(&env);
    client.add_issuer(&other_issuer);
    client.mint(&issuer, &owner, &0);

    assert_eq!(
        client.try_revoke(&other_issuer, &owner),
        Err(Ok(Error::Unauthorized))
    );
    assert!(client.is_valid(&owner));
}

#[test]
fn badge_expires() {
    let Setup { env, client, issuer } = setup();
    let owner = Address::generate(&env);
    env.ledger().set_timestamp(100);

    assert_eq!(
        client.try_mint(&issuer, &owner, &100),
        Err(Ok(Error::InvalidExpiry))
    );

    client.mint(&issuer, &owner, &200);
    assert!(client.is_valid(&owner));

    env.ledger().set_timestamp(200);
    assert!(!client.is_valid(&owner));
    assert_eq!(client.balance(&owner), 0);

    // An expired credential can be re-issued.
    client.mint(&issuer, &owner, &0);
    assert!(client.is_valid(&owner));
}

#[test]
fn mint_emits_standard_event() {
    let Setup { env, client, issuer } = setup();
    let owner = Address::generate(&env);

    client.mint(&issuer, &owner, &0);

    let (contract_id, topics, _) = env.events().all().last().unwrap();
    assert_eq!(contract_id, client.address);
    assert_eq!(
        EventTopics::parse(&env, &topics),
        Some(EventTopics {
            contract: Symbol::new(&env, "sbt_identity"),
            action: Symbol::new(&env, "mint"),
            wallet: owner,
        })
    );
}
