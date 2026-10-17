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

## Dynamic Policy Reload via Redis Pub/Sub

The policy store caches wallet policies in memory per replica to keep evaluation fast.
To avoid requiring server restarts or per-replica REST calls when policies change, the
store subscribes to a Redis Pub/Sub channel and invalidates its local cache whenever an
update event is received.

### Channel

- **Channel name**: \`lumen:policies:updated\`

All replicas in the cluster subscribe to this channel on startup. When an admin creates,
updates, or deletes a policy, the server publishes an update event to the channel. Every
replica — including the one that handled the admin request — receives the event and
invalidates its local in-memory policy cache, so subsequent evaluations read fresh
policies from the backing store.

### Payload Shape

The published message is a JSON-encoded object:

\`\`\`json
{
  "type": "policy.updated",
  "walletAddress": "G...",
  "policyId": "policy_123",
  "timestamp": 1700000000000
}
\`\`\`

Fields:

- \`type\`: the event type. Currently \`policy.updated\` (covers create, update, and delete).
- \`walletAddress\`: the wallet address whose policies changed. Replicas invalidate the
  cached policy set for this wallet.
- \`policyId\`: the identifier of the affected policy, for observability and targeted
  invalidation.
- \`timestamp\`: epoch milliseconds when the event was published.

### Cross-Replica Cache Invalidation

1. An admin updates a policy via the API on any replica.
2. That replica persists the change and publishes an event to \`lumen:policies:updated\`.
3. All replicas (including the publisher) receive the event via their subscription.
4. Each replica invalidates the cached policies for the affected wallet (or the entire
   local policy cache if the wallet cannot be determined).
5. The next evaluation on each replica reloads policies from the backing store.

Because invalidation is event-driven and asynchronous, all replicas converge on the new
policy state within 100ms of the Redis event being emitted, satisfying the multi-instance
deployment acceptance criteria. If the Redis connection drops, the store re-subscribes on
reconnect and invalidates its full local cache to guard against missed events.