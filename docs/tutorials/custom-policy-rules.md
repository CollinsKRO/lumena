# Writing Custom Policy Rules

Learn how to write and register custom policy rules for Lumen smart accounts. By the end of this tutorial you will have implemented a spend-limit rule, a velocity rule, and an allowlist rule, registered them with the policy API, and verified that transactions are accepted or rejected as expected.

> **Prerequisites**
> - Node.js 20+ and `pnpm` installed
> - A fresh clone of the repository (`git clone <repo-url> && cd lumen`)
> - Dependencies installed (`pnpm install`)
> - A running local devnet (`pnpm devnet:start`) — see the [Quickstart](../quickstart.md)
> - Basic familiarity with TypeScript and the Soroban smart account model
>
> **Recommended reading:** [Policy Engine Architecture](../../architecture/policy-engine.md) for the full evaluation model, rule lifecycle, and on-chain/off-chain split.

---

## 1. How the Policy Engine Evaluates Transactions

Every transaction submitted through a Lumen smart account passes through the `PolicyEngine`. Rules are evaluated in order of priority; the first rule that returns a rejection short-circuits evaluation and the transaction is refused.

```
                 ┌──────────────────────────────┐
                 │   Transaction submitted      │
                 │   (from dApp / SDK)          │
                 └──────────────┬───────────────┘
                                │
                                ▼
                 ┌──────────────────────────────┐
                 │        PolicyEngine          │
                 │  (loads rules for account)   │
                 └──────────────┬───────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │ SpendLimit   │  │  Velocity    │  │  Allowlist   │
      │   Rule       │  │    Rule      │  │    Rule      │
      │ priority: 10 │  │ priority: 20 │  │ priority: 30 │
      └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
             │                 │                 │
             └────────┬────────┴────────┬────────┘
                      ▼                 ▼
              ┌──────────────┐  ┌──────────────┐
              │   ACCEPT     │  │   REJECT     │
              │ (all pass)   │  │ (any fails)  │
              └──────────────┘  └──────────────┘
```

Each rule implements the `PolicyRule` interface:

```ts
export interface PolicyRule {
  /** Unique identifier, e.g. "spend-limit" */
  id: string;
  /** Lower numbers evaluate first */
  priority: number;
  /** Return a decision for the given transaction context */
  evaluate(ctx: PolicyContext): Promise<PolicyDecision>;
}

export type PolicyDecision =
  | { allow: true }
  | { allow: false; reason: string };
```

---

## 2. Scaffold the Project

Create a working directory and initialize a TypeScript project:

```bash
mkdir lumen-policies && cd lumen-policies
pnpm init
pnpm add @lumen/sdk @lumen/policy-rules
pnpm add -D typescript tsx @types/node
npx tsc --init --target ES2022 --module NodeNext --moduleResolution NodeNext
```

Create `src/index.ts` — we will build up the rules here.

```ts
import { PolicyEngine, PolicyContext, PolicyDecision, PolicyRule } from '@lumen/sdk';
```

---

## 3. Writing the Spend-Limit Rule

The spend-limit rule rejects any transaction whose amount exceeds a configured cap within a rolling window.

```ts
import { PolicyRule, PolicyContext, PolicyDecision } from '@lumen/sdk';

export class SpendLimitRule implements PolicyRule {
  id = 'spend-limit';
  priority = 10;

  constructor(
    private readonly limit: bigint,        // max amount per window
    private readonly windowMs: number,     // rolling window length
  ) {}

  async evaluate(ctx: PolicyContext): Promise<PolicyDecision> {
    const spent = await ctx.ledger.sumSpent({
      account: ctx.account,
      since: ctx.now - this.windowMs,
    });

    if (spent + ctx.tx.amount > this.limit) {
      return {
        allow: false,
        reason: `spend-limit exceeded: ${spent + ctx.tx.amount} > ${this.limit}`,
      };
    }
    return { allow: true };
  }
}
```

---

## 4. Writing the Velocity Rule

The velocity rule limits the *number* of transactions in a window, independent of amount. This complements the spend-limit rule and mitigates rapid drain attacks.

```ts
import { PolicyRule, PolicyContext, PolicyDecision } from '@lumen/sdk';

export class VelocityRule implements PolicyRule {
  id = 'velocity';
  priority = 20;

  constructor(
    private readonly maxTx: number,        // max transactions per window
    private readonly windowMs: number,
  ) {}

  async evaluate(ctx: PolicyContext): Promise<PolicyDecision> {
    const count = await ctx.ledger.countTransactions({
      account: ctx.account,
      since: ctx.now - this.windowMs,
    });

    if (count + 1 > this.maxTx) {
      return {
        allow: false,
        reason: `velocity exceeded: ${count + 1} > ${this.maxTx} tx in ${this.windowMs}ms`,
      };
    }
    return { allow: true };
  }
}
```

---

## 5. Writing the Allowlist Rule

The allowlist rule restricts the set of destination addresses a smart account may interact with. Any address not on the list is rejected.

```ts
import { PolicyRule, PolicyContext, PolicyDecision } from '@lumen/sdk';

export class AllowlistRule implements PolicyRule {
  id = 'allowlist';
  priority = 30;

  constructor(private readonly allowed: Set<string>) {}

  async evaluate(ctx: PolicyContext): Promise<PolicyDecision> {
    if (!this.allowed.has(ctx.tx.destination)) {
      return {
        allow: false,
        reason: `destination ${ctx.tx.destination} not in allowlist`,
      };
    }
    return { allow: true };
  }
}
```

---

## 6. Registering Rules with the Policy API

Assemble the rules into a `PolicyEngine` and register them against your smart account. The engine persists rule configuration on-chain via the policy contract.

```ts
import { PolicyEngine } from '@lumen/sdk';
import { SpendLimitRule } from './rules/spend-limit';
import { VelocityRule } from './rules/velocity';
import { AllowlistRule } from './rules/allowlist';

const engine = new PolicyEngine({
  rpcUrl: 'http://localhost:8000/soroban/rpc',
  networkPassphrase: 'Standalone Network ; February 2017',
});

const account = 'GABC...YOUR_SMART_ACCOUNT...';

await engine.register(account, [
  new SpendLimitRule(1_000_000_000n, 24 * 60 * 60 * 1000), // 100 XLM / 24h
  new VelocityRule(10, 60 * 60 * 1000),                    // 10 tx / 1h
  new AllowlistRule(new Set([
    'GDEST...MERCHANT_A...',
    'GDEST...MERCHANT_B...',
  ])),
]);

console.log('Rules registered for', account);
```

Run it:

```bash
pnpm tsx src/index.ts
```

Expected output:

```
Rules registered for GABC...YOUR_SMART_ACCOUNT...
```

---

## 7. Verifying the Rules

Now submit transactions through the engine and confirm the decisions.

### 7.1 Rejected Transaction

Send a transaction to an address **not** on the allowlist:

```ts
const decision = await engine.evaluate(account, {
  amount: 500_000_000n, // 50 XLM — within spend limit
  destination: 'GUNKNOWN...NOT_ALLOWED...',
});

console.log(decision);
```

Expected output:

```ts
{
  allow: false,
  reason: 'destination GUNKNOWN...NOT_ALLOWED... not in allowlist'
}
```

The transaction is rejected because the allowlist rule (priority 30) fails. Note that the spend-limit and velocity rules passed first — evaluation short-circuits on the first rejection.

### 7.2 Accepted Transaction

Send a transaction to an allowlisted address within all limits:

```ts
const decision = await engine.evaluate(account, {
  amount: 500_000_000n, // 50 XLM — within spend limit
  destination: 'GDEST...MERCHANT_A...',
});

console.log(decision);
```

Expected output:

```ts
{ allow: true }
```

All three rules pass, so the transaction is accepted.

### 7.3 Exceeding the Spend Limit

For completeness, verify the spend-limit rule fires:

```ts
const decision = await engine.evaluate(account, {
  amount: 2_000_000_000n, // 200 XLM — exceeds 100 XLM cap
  destination: 'GDEST...MERCHANT_A...',
});

console.log(decision);
```

Expected output:

```ts
{
  allow: false,
  reason: 'spend-limit exceeded: 2000000000 > 1000000000'
}
```

---

## 8. Next Steps

- Read the [Policy Engine Architecture](../../architecture/policy-engine.md) for details on rule storage, upgrade paths, and the on-chain evaluator.
- Explore the [Gasless React dApp tutorial](./gasless-react-dapp.md) to see policies in action from a frontend.
- Deploy your smart account with the [Soroban Smart Account tutorial](./deploy-soroban-smart-account.md).

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `PolicyEngine: account not found` | Smart account not deployed | Run `pnpm devnet:start` and deploy via the smart-account tutorial |
| `RPC connection refused` | Devnet not running | Start devnet with `pnpm devnet:start` |
| Rules not applied | Registered against wrong account | Confirm the `account` argument matches your deployed smart account |
| `bigint` type errors | `tsconfig` target too low | Set `"target": "ES2022"` in `tsconfig.json` |