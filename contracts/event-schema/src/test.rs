use super::*;
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, testutils::Events as _, vec, Env,
};

#[contract]
pub struct Emitter;

#[contractimpl]
impl Emitter {
    pub fn emit(env: Env, wallet: Address, amount: i128) {
        publish(
            &env,
            Symbol::new(&env, "emitter"),
            Symbol::new(&env, "ping"),
            &wallet,
            amount,
        );
    }
}

#[test]
fn publishes_standard_topics() {
    let env = Env::default();
    let contract_id = env.register(Emitter, ());
    let wallet = Address::generate(&env);

    EmitterClient::new(&env, &contract_id).emit(&wallet, &42);

    let (emitter, topics, data) = env.events().all().last().unwrap();
    assert_eq!(emitter, contract_id);
    assert_eq!(
        EventTopics::parse(&env, &topics),
        Some(EventTopics {
            contract: Symbol::new(&env, "emitter"),
            action: Symbol::new(&env, "ping"),
            wallet,
        })
    );
    assert_eq!(i128::try_from_val(&env, &data).unwrap(), 42);
}

#[test]
fn rejects_non_standard_topics() {
    let env = Env::default();
    let wallet = Address::generate(&env);
    let action = Symbol::new(&env, "ping");

    let too_short: Vec<Val> = vec![&env, action.into_val(&env)];
    assert_eq!(EventTopics::parse(&env, &too_short), None);

    let wrong_order: Vec<Val> = vec![
        &env,
        wallet.into_val(&env),
        action.into_val(&env),
        action.into_val(&env),
    ];
    assert_eq!(EventTopics::parse(&env, &wrong_order), None);
}
