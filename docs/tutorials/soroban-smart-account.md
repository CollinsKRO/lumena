# Deploying a Soroban Smart Account

> **Video script companion:** This walkthrough is the written companion to the "Deploying a Soroban Smart Account" onboarding video. Follow along step-by-step, or watch the video and pause at each section.

In this tutorial you will deploy a Soroban smart account contract to the Stellar testnet, invoke it, and verify the deployment. By the end you will have a working smart account that can be sponsored, protected by policy rules, and activated for gasless transactions.

**Estimated time:** 15–20 minutes

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Wallet Lifecycle Overview](#wallet-lifecycle-overview)
3. [Step 1: Clone and Build](#step-1-clone-and-build)
4. [Step 2: Configure Testnet Identity](#step-2-configure-testnet-identity)
5. [Step 3: Deploy the Contract](#step-3-deploy-the-contract)
6. [Step 4: Invoke the Contract](#step-4-invoke-the-contract)
6. [Step 5: Verify the Deployment](#step-5-verify-the-deployment)
7. [Troubleshooting](#troubleshooting)
8. [Next Steps](#next-steps)

---

## Prerequisites

Before you begin, make sure you have the following installed and configured:

| Tool | Version | Install |
| --- | --- | --- |
| Rust | 1.74+ | [rustup.rs](https://rustup.rs) |
| `wasm32-unknown-unknown` target | — | `rustup target add wasm32-unknown-unknown` |
| Stellar CLI | 21.0+ | [Stellar CLI install guide](https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli) |
| Git | any | [git-scm.com](https://git-scm.com) |

Verify your toolchain:

```bash
rustc --version
stellar --version
rustup target list --installed | grep wasm32
```

You should see `wasm32-unknown-unknown` in the installed targets list. If not, run:

```bash
rustup target add wasm32-unknown-unknown
```

> **Note:** This tutorial targets the Stellar testnet. No real funds are required.

---

## Wallet Lifecycle Overview

A Lumen smart account moves through four lifecycle states. Understanding this flow is essential before deploying.

```
   ┌─────────────┐        ┌──────────────┐        ┌──────────────┐        ┌────────────┐
   │  GENERATED  │───────▶│  SPONSORED   │───────▶│  PROTECTED   │───────▶│   ACTIVE   │
   └─────────────┘        └──────────────┘        └──────────────┘        └────────────┘
         │                       │                       │                       │
   Keypair created        Sponsor funds the        Policy rules attached    Account ready
   locally; no funds      account (fee-bump or     (spending limits,        for gasless
   or policies yet.       sponsorship service).    allowlists, etc.).       transactions.
         │                       │                       │                       │
         ▼                       ▼                       ▼                       ▼
   Contract deployed      Account has XLM         Rules enforced on        dApp can submit
   with owner key.        balance for fees.       every invocation.        fee-bump txs.
```

| State | Description | What happens |
| --- | --- | --- |
| **Generated** | A fresh keypair and contract address are created locally. | The smart account contract is deployed with the owner key set. |
| **Sponsored** | A sponsor (or faucet) funds the account. | The account receives XLM to cover future fees and storage. |
| **Protected** | Policy rules are attached to the account. | Spending limits, allowlists, and other rules are registered. |
| **Active** | The account is fully operational. | Gasless transactions can be submitted via fee-bump. |

For a deeper dive into each state and the transitions between them, see the [Wallet Lifecycle architecture doc](../architecture/wallet-lifecycle.md).

---

## Step 1: Clone and Build

Clone the repository and build the smart account contract to WebAssembly.

```bash
git clone https://github.com/lumen-network/lumen.git
cd lumen
```

Build the smart account contract:

```bash
cd contracts/smart-account
cargo build --target wasm32-unknown-unknown --release
```

The compiled Wasm artifact will be at:

```
contracts/smart-account/target/wasm32-unknown-unknown/release/smart_account.wasm
```

Confirm the artifact exists:

```bash
ls -lh target/wasm32-unknown-unknown/release/smart_account.wasm
```

> **Tip:** If the build fails, ensure your Rust toolchain is up to date with `rustup update`.

---

## Step 2: Configure Testnet Identity

The Stellar CLI needs a funded identity to sign deployment transactions. Generate and fund a testnet identity:

```bash
stellar keys generate --global deployer --network testnet
```

Fund the account using Friendbot:

```bash
stellar keys fund deployer --network testnet
```

Verify the account is funded:

```bash
stellar keys address deployer
stellar account show --id $(stellar keys address deployer) --network testnet
```

You should see a non-zero XLM balance in the output.

---

## Step 3: Deploy the Contract

Deploy the compiled Wasm to the testnet. The `deploy` command uploads the Wasm, creates a contract instance, and invokes the constructor with the owner address.

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/smart_account.wasm \
  --source deployer \
  --network testnet \
  -- \
  --owner $(stellar keys address deployer)
```

The command prints the new contract ID. Save it to an environment variable for the next steps:

```bash
export SMART_ACCOUNT_ID=<paste-contract-id-here>
```

> **Note:** The contract ID starts with `C` and is 56 characters long. Double-check you copied the full ID.

---

## Step 4: Invoke the Contract

Now that the contract is deployed, invoke it to confirm it responds correctly. First, query the owner:

```bash
stellar contract invoke \
  --id $SMART_ACCOUNT_ID \
  --source deployer \
  --network testnet \
  -- \
  owner
```

The output should match the address of your `deployer` identity.

Next, check the account's current lifecycle state:

```bash
stellar contract invoke \
  --id $SMART_ACCOUNT_ID \
  --source deployer \
  --network testnet \
  -- \
  state
```

A freshly deployed account returns `Generated`. To move it to `Sponsored`, fund the contract address:

```bash
stellar keys fund $SMART_ACCOUNT_ID --network testnet
```

Re-run the `state` invocation — it should now return `Sponsored`.

---

## Step 5: Verify the Deployment

Verify the deployment on a block explorer and via the CLI.

### CLI verification

Fetch the contract's ledger entry to confirm it exists on-chain:

```bash
stellar contract fetch \
  --id $SMART_ACCOUNT_ID \
  --network testnet
```

You should see the contract's Wasm hash and instance storage in the output.

### Explorer verification

Open the Stellar testnet explorer and search for your contract ID:

```
https://stellar.expert/explorer/testnet/contract/<your-contract-id>
```

You should see:
- The contract creation transaction
- The constructor invocation with your owner address
- The funding transaction (if you completed Step 4)

### Checklist

- [ ] Contract Wasm built successfully
- [ ] `deployer` identity generated and funded
- [ ] Contract deployed and contract ID captured
- [ ] `owner` invocation returns the deployer address
- [ ] `state` invocation returns `Generated`, then `Sponsored` after funding
- [ ] Contract visible on Stellar Expert testnet explorer

If all boxes are checked, your smart account is deployed and verified. 🎉

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `error: no such command: deploy` | Stellar CLI too old | Upgrade to CLI 21.0+ |
| `wasm32-unknown-unknown` not found | Missing target | `rustup target add wasm32-unknown-unknown` |
| `account not found` on deploy | Identity not funded | Run `stellar keys fund deployer --network testnet` |
| `HostError: Error(Contract, #1)` | Constructor argument mismatch | Confirm `--owner` is passed after `--` |
| Contract ID not found on explorer | Wrong network | Ensure `--network testnet` on every command |

---

## Next Steps

Now that your smart account is deployed, continue with:

- **[Building a Gasless React dApp in 10 Minutes](./gasless-react-dapp.md)** — wire your smart account into a React frontend with fee-bump transactions.
- **[Writing Custom Policy Rules](./custom-policy-rules.md)** — move your account from `Sponsored` to `Protected` by attaching policy rules.
- **[Wallet Lifecycle Architecture](../architecture/wallet-lifecycle.md)** — understand the full state machine and transition guarantees.

---

*Part of the [Lumen tutorials](./README.md) series. Found an issue? [Open a ticket](https://github.com/lumen-network/lumen/issues).*