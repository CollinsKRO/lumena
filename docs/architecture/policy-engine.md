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

## Policy Guard Contract (Cross-Contract Invocation Policy)

The off-chain \`PolicyEngine\` protects the *transaction* layer, but it cannot inspect the
sub-contracts a Soroban invocation will call at execution time. Wallets that execute batch
Soroban calls therefore need an **on-chain** guarantee that every called sub-contract has
verified source code and belongs to a trusted protocol registry. The \`policy-guard\` contract
(\`contracts/policy-guard/\`) provides this guarantee.

### Verified-Contract Registry

The contract maintains an on-chain registry of verified contracts, keyed by contract address:

- **Verified contract hashes**: each registered entry stores the expected code hash of the
  contract, so callers can confirm the deployed bytecode matches the audited/verified source.
- **Trusted protocol registries**: contracts may be registered as members of trusted protocol
  registries, allowing wallets to express policy in terms of protocols rather than individual
  addresses.
- **Registration / deregistration**: administrative entry points add, update, and remove
  registry entries. Only authorized administrators may mutate the registry.

### \`validate_invocation\` Guard

Before dispatching execution, the wallet calls \`validate_invocation\` on the guard. The guard:

1. Inspects the invocation's call targets (the dynamic call graph of the batch).
2. Checks \`env.current_contract_address()\` and each authorized call target against the
   verified-contract registry.
3. Rejects the invocation if any target is unregistered, has a mismatched code hash, or does
   not belong to a trusted protocol registry.
4. Approves the invocation if all targets are registered and verified.

Because the check runs on-chain, it cannot be bypassed by a compromised client and applies
uniformly to every invocation routed through the guard.

### Relationship to the Off-Chain PolicyEngine

The two layers are complementary:

- **Off-chain \`PolicyEngine\`**: evaluates spend limits, allowlists, velocity limits, and
  session keys on the transaction *before* co-signing. It has no visibility into the
  sub-contracts a Soroban invocation will reach.
- **On-chain \`policy-guard\`**: enforces cross-contract invocation policy at execution time,
  ensuring every called sub-contract is verified and trusted.

Together they cover both the transaction envelope and the dynamic call graph. Unregistered
contracts are rejected, while registered, verified contracts execute with zero overhead
beyond the registry lookup.