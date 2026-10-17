# PolicyEngine Architecture

Lumen's \`PolicyEngine\` evaluates every transaction before co-signing to protect user funds:

- **Spend Limits**: Per-transaction and daily ceilings evaluated per asset (e.g. XLM vs USDC).
- **Multi-Op Checking**: Sums amounts across all payment operations in the transaction.
- **Allowlists**: Verifies all payment and path payment destinations against approved addresses.
- **Velocity Limits**: Caps the number of transactions permitted within sliding time windows.
- **Session Keys**: Enforces expiration timestamps and cumulative spend allowances for delegated keys.

## On-Chain Session Key Delegation Contract

Off-chain policy engines can be bypassed if raw account credentials leak. To close this gap,
Lumen ships an on-chain Session Key Delegation contract (in \`contracts/session-keys/\`) that
enforces session key permissions directly at the Soroban consensus layer, independently of the
off-chain \`PolicyEngine\`.

### Registration

Account owners register temporary public keys with the following parameters:

- \`valid_until: u64\`: the ledger timestamp after which the session key is no longer valid.
- \`allowed_contracts: Vec<Address>\`: the set of target contracts the session key may call.
- \`allowed_methods: Vec<Symbol>\`: the set of contract methods the session key may invoke.
- \`max_cumulative_amount: i128\`: the total cumulative amount the session key may spend across
  all calls before its quota is exhausted.

### Validation

The contract exposes:

\`\`\`
validate_session_call(session_key: Address, target: Address, method: Symbol, amount: i128) -> bool
\`\`\`

This returns \`true\` only when **all** of the following hold:

- The session key is registered and has not expired (\`valid_until\` is in the future).
- The \`target\` contract is present in \`allowed_contracts\`.
- The \`method\` symbol is present in \`allowed_methods\`.
- The \`amount\`, when added to the key's cumulative spend, does not exceed
  \`max_cumulative_amount\`.

The contract therefore rejects expired keys, unlisted targets (and methods), and amounts that
would exceed the cumulative quota.

### Relationship to the Off-Chain PolicyEngine

The on-chain contract and the off-chain \`PolicyEngine\` are complementary layers:

- The **off-chain PolicyEngine** performs richer, pre-signing checks (spend limits, multi-op
  summation, destination allowlists, velocity limits) and can be updated without a contract
  upgrade.
- The **on-chain contract** provides a hard, consensus-level backstop: even if off-chain policy
  is bypassed or raw credentials leak, a session key cannot call unlisted contracts or methods,
  cannot operate past \`valid_until\`, and cannot exceed its cumulative quota.

Both layers should be configured consistently so that a session key accepted off-chain is also
accepted on-chain, and vice versa.

## Session Key Rejection Webhook

When \`PolicyEngine.evaluateSessionKey()\` rejects a session key, the engine dispatches a
\`session_key.rejected\` webhook event so operators can monitor delegated key activity.

Rejections are emitted for both causes:

- **Expired key**: the session key's \`expiresAt\` timestamp has passed.
- **Spend cap exceeded**: the session key's cumulative spend allowance would be exceeded.

The event payload includes:

- \`sessionPublicKey\`: the public key of the rejected session key.
- \`walletAddress\`: the wallet address the session key was delegated for.
- \`reason\`: the rejection reason (e.g. expired or spend cap exceeded).

\`session_key.rejected\` is a member of the \`WebhookEventType\` union, so subscribers can
filter for it alongside other webhook events.