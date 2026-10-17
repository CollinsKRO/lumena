# Wallet Lifecycle

Lumena wallets move through four operational states:

1. Generated: a local keypair or passkey credential is created.
2. Sponsored: the sponsor account funds the wallet and pays the setup fee.
3. Protected: multisig is configured so the server co-signer enforces policy.
4. Active: payments, contract calls, and sponsored fee-bump submissions are available.

Recovery and closure should keep policy in sync with on-chain state. When a wallet is retired, remove stored policy, stop sponsor monitoring for the account, and use account merge only after balances, trustlines, and claimable balances are cleared.

## Social Recovery

Seedless wallets rely on social recovery so that a lost passkey or device key can be restored without a centralized server holding custody. The Social Recovery contract (`contracts/social-recovery/`) implements this as an M-of-N guardian scheme with a configurable timelock.

### Guardian Registration

The wallet owner registers N guardian addresses (for example emails, friends, or secondary devices) and configures:

- An M-of-N threshold: at least M guardians must approve a recovery before it can execute.
- A configurable timelock (e.g., 48 hours) that defines the grace period between a recovery reaching threshold and its execution.

Guardian registration and threshold/timelock configuration are owner-controlled and keep the on-chain recovery policy in sync with the wallet's protected state.

### Recovery Initiation

When the owner loses access to their key, a recovery is initiated against the wallet, proposing a new key (key rotation target). Initiation opens a recovery proposal that guardians can vote on.

### Guardian Voting

Registered guardians vote to approve the proposed recovery. Once the number of approving guardians reaches the M-of-N threshold, the recovery becomes eligible for execution, subject to the timelock.

### Timelock Grace Period

After the threshold is met, the recovery must wait for the configured timelock to elapse before it can be executed. This grace period gives the legitimate owner time to notice an unauthorized recovery attempt.

### Owner Cancellation

During the grace period, the legitimate owner can cancel the pending recovery. Cancellation aborts the proposal so that the key rotation is never executed, protecting the wallet from malicious or mistaken recovery attempts.

### Execution of Key Rotation

Once the timelock has elapsed and the recovery has not been cancelled, execution performs the key rotation, replacing the lost key with the proposed new key. The wallet then returns to its normal lifecycle states (Protected and Active) under the new key, with recovery policy intact.

### Fit Within the Seedless Wallet Lifecycle

Social recovery complements the four operational states above: it is configured while the wallet is Protected, remains dormant while Active, and is invoked when a key is lost. Because recovery is enforced on-chain by the guardian contract rather than by a server, restoring account ownership does not reintroduce centralization. As with other lifecycle transitions, recovery and any resulting policy changes should keep off-chain policy in sync with on-chain state.