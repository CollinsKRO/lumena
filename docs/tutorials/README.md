# Tutorials

Step-by-step, copy-paste-friendly walkthroughs for building on Lumen. Each tutorial is verified end-to-end from a fresh clone and includes ASCII diagrams plus runnable code snippets.

## Walkthroughs

| Tutorial | Description |
| --- | --- |
| [Building a Gasless React dApp in 10 Minutes](./gasless-react-dapp.md) | Scaffold a React app that sends gasless transactions through a Lumen smart account using a paymaster. |
| [Deploying a Soroban Smart Account](./deploying-soroban-smart-account.md) | Deploy and initialize a Soroban smart account contract on testnet, then verify it on-chain. |
| [Writing Custom Policy Rules](./writing-custom-policy-rules.md) | Author, register, and test custom policy rules that gate transactions on your smart account. |

## Prerequisites

Before starting any tutorial, make sure you have:

- **Node.js 20+** — `node --version` should report `v20` or newer.
- **pnpm** — install via `npm install -g pnpm` (or `corepack enable`).
- **A funded testnet account** — a Stellar testnet keypair with XLM for fees and contract deployment. Fund it with [Friendbot](https://friendbot.stellar.org/).

## Related Documentation

- [Gasless Transactions Guide](../guides/gasless-transactions.md) — how paymasters and fee sponsorship work.
- [Policy Engine Architecture](../architecture/policy-engine.md) — the design behind policy rules and enforcement.
- [Wallet Lifecycle Architecture](../architecture/wallet-lifecycle.md) — account creation, key management, and recovery flows.

## Contributing a Tutorial

1. Fork the repo and create your branch: `git checkout -b feature/issue-<number>`
2. Add your tutorial as a new markdown file in this directory and link it in the table above.
3. Verify every step from a fresh clone before opening a PR.
4. Submit a Pull Request referencing the issue: `Fixes #<number>`