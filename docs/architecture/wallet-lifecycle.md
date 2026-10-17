# Wallet Lifecycle

Lumena wallets move through four operational states:

1. Generated: a local keypair or passkey credential is created.
2. Sponsored: the sponsor account funds the wallet and pays the setup fee.
3. Protected: multisig is configured so the server co-signer enforces policy.
4. Active: payments, contract calls, and sponsored fee-bump submissions are available.

Recovery and closure should keep policy in sync with on-chain state. When a wallet is retired, remove stored policy, stop sponsor monitoring for the account, and use account merge only after balances, trustlines, and claimable balances are cleared.

## Dead-Man's Switch and Inheritance Vault

The inheritance vault (`contracts/inheritance/`) provides inactivity-triggered inheritance for seedless wallets, ensuring digital assets are not lost if the user becomes incapacitated. It is an on-chain Soroban contract that tracks wallet activity and hands custody to a designated beneficiary once the wallet goes dormant.

### Heartbeat Tracking

The contract stores a `last_heartbeat` timestamp for each wallet. Any wallet activity refreshes this timestamp, keeping the wallet marked as alive. The heartbeat is the single source of truth for dormancy: as long as it is being updated, the wallet is considered active and no inheritance action can proceed.

### Dormancy Period

Each wallet has a configured `dormancy_period`. The wallet is considered dormant when:

```
current_time - last_heartbeat > dormancy_period
```

While `current_time - last_heartbeat` is within the dormancy period, the wallet is active and beneficiary claims are rejected.

### Beneficiary Designation

The wallet owner designates a beneficiary (an account or address) that is authorized to claim custody of the wallet's assets. The beneficiary is recorded in the contract alongside the heartbeat and dormancy configuration, and can be updated by the owner while the wallet is active.

### Custody-Claim Flow

1. The owner (or any wallet activity) updates `last_heartbeat`, resetting the dormancy clock.
2. If the owner stops updating the heartbeat, the dormancy period elapses.
3. Once `current_time - last_heartbeat > dormancy_period`, the designated beneficiary may submit a claim.
4. The contract verifies the caller is the designated beneficiary and that the wallet is dormant, then transfers custody of the assets to the beneficiary.
5. Claims submitted while the heartbeat is still active (within the dormancy period) fail, preserving the owner's control.

This flow guarantees that a claim can only succeed after the dormancy period has expired, and that any heartbeat activity blocks a claim.