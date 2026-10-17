# PolicyEngine Architecture

Lumen's \`PolicyEngine\` evaluates every transaction before co-signing to protect user funds:

- **Spend Limits**: Per-transaction and daily ceilings evaluated per asset (e.g. XLM vs USDC).
- **Multi-Op Checking**: Sums amounts across all payment operations in the transaction.
- **Allowlists**: Verifies all payment and path payment destinations against approved addresses.
- **Velocity Limits**: Caps the number of transactions permitted within sliding time windows.
- **Session Keys**: Enforces expiration timestamps and cumulative spend allowances for delegated keys.

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

## On-Chain Policy Contracts

In addition to the off-chain \`PolicyEngine\`, Lumen ships Soroban contracts under
\`contracts/\` that enforce spending policy directly on-chain. This provides defense in
depth: even if a co-signer is compromised and the off-chain engine is bypassed, the
on-chain contract still rejects transactions that exceed the configured allowance.

### Spend Policy Contract (\`contracts/spend-policy/\`)

The \`spend-policy\` contract mirrors the TypeScript \`SpendLimit\` rule, moving the
enforcement of daily spending ceilings onto the ledger:

- **Per-asset tracking**: Allowances are tracked independently per asset (e.g. XLM vs
  USDC), matching the per-asset ceilings of the off-chain \`SpendLimit\` rule.
- **Rolling 24-hour windows**: The contract maintains a sliding 24-hour window per
  asset. Each spend consumes from the remaining budget, and the budget restores
  correctly as time advances and older consumption falls out of the window.
- **Rejection of over-budget spends**: Any transaction that would exceed the remaining
  allowance within the current 24-hour window is rejected.
- **Master-key delayed overrides**: The master key may override or adjust limits, but
  such changes take effect only after a 24-hour delay. This prevents a compromised
  master key from immediately raising limits to drain funds.

### Relationship to the Off-Chain PolicyEngine

The on-chain contracts complement rather than replace the off-chain \`PolicyEngine\`:

- The \`PolicyEngine\` performs richer, pre-signing evaluation (multi-op summing,
  allowlists, velocity limits, session keys) and provides fast feedback and webhook
  notifications.
- The \`spend-policy\` contract provides a trust-minimized backstop that enforces the
  same per-asset daily ceilings on-chain, ensuring the documented spend-limit
  semantics hold even when the off-chain layer is unavailable or compromised.

Both layers should be configured with consistent per-asset limits so that the
off-chain evaluation and the on-chain enforcement agree.
