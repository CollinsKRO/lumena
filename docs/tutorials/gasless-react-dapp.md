# Building a Gasless React dApp in 10 Minutes

In this tutorial you'll build a small React application that sends a Stellar payment **without the user ever holding XLM for fees**. The transaction fee is sponsored by a Lumen cosigner, and the user's account is created and operated through a Soroban smart account.

By the end you will have:

- A working React dApp that connects to a Lumen smart account.
- A gasless payment flow using `LumenProvider` and `useSendPayment`.
- A verification checklist to confirm everything works end-to-end.

> **Prerequisites:** Familiarity with React and basic Stellar concepts (accounts, transactions, fees). If you're new to gasless transactions, read the [Gasless Transactions guide](../guides/gasless-transactions.md) first.

---

## 1. Prerequisites

Before you start, make sure you have:

- **Node.js 18+** and **npm 9+** (or `pnpm`/`yarn`).
- A **Lumen server** running locally or a hosted endpoint. See the [server quickstart](../guides/gasless-transactions.md#running-the-cosigner) for setup.
- A **fee-sponsor account** funded on Stellar Testnet (the Lumen server manages this for you in dev mode).
- A **Soroban smart account** for the end user. The tutorial creates one on the fly via the SDK.
- A browser with a Stellar wallet extension (e.g. Freighter) **or** the Lumen dev signer (used in this tutorial).

Clone the Lumen repo and install dependencies:

```bash
git clone https://github.com/lumen-network/lumen.git
cd lumen
npm install
```

---

## 2. Architecture Overview

The gasless flow has four moving parts. The browser never signs a fee-bearing transaction — the Lumen server does that on the user's behalf, after verifying the user's signature over the *operation*.

```
┌─────────────────────────────┐
│        Browser dApp         │
│  React + @lumen/web-sdk     │
│                             │
│  LumenProvider              │
│  useSendPayment()           │
└──────────────┬──────────────┘
               │  1. build + sign intent
               │     (user key signs op hash)
               ▼
┌─────────────────────────────┐
│      @lumen/web-sdk         │
│  LumenClient                │
│  - builds tx envelope       │
│  - attaches user signature  │
└──────────────┬──────────────┘
               │  2. POST /sponsor (signed intent)
               ▼
┌─────────────────────────────┐
│      @lumen/server          │
│  Cosigner + Fee Sponsor     │
│  - verifies intent          │
│  - adds fee-bump signature  │
│  - submits to network       │
└──────────────┬──────────────┘
               │  3. submit fee-bump tx
               ▼
┌─────────────────────────────┐
│          Horizon            │
│  (Stellar Testnet)          │
│  - validates + includes tx  │
└─────────────────────────────┘
```

**Key idea:** the user signs the *operation* (the payment), and the Lumen server wraps it in a **fee-bump transaction** signed by the sponsor. The user pays zero fees.

---

## 3. Scaffold the React App

Create a new Vite + React + TypeScript project:

```bash
npm create vite@latest gasless-dapp -- --template react-ts
cd gasless-dapp
npm install
```

Install the Lumen packages:

```bash
npm install @lumen/web-sdk @lumen/server-client
npm install --save-dev @types/node
```

> `@lumen/server-client` is a thin typed client for the Lumen cosigner API. If you're running the server locally, point it at `http://localhost:8787`.

---

## 4. Configure the Lumen Client

Create `src/lumen.ts` to hold your SDK configuration. This is where you tell the SDK which network, which cosigner endpoint, and which smart account to use.

```ts
// src/lumen.ts
import { LumenClient } from "@lumen/web-sdk";

export const lumen = new LumenClient({
  network: "testnet",
  // The Lumen cosigner endpoint. In production this is your hosted server.
  cosignerUrl: import.meta.env.VITE_LUMEN_COSIGNER_URL ?? "http://localhost:8787",
  // The smart account contract the user operates through.
  // In dev mode the SDK will deploy one for you on first use.
  smartAccount: {
    mode: "auto", // "auto" | "existing"
    // If mode === "existing", provide the contract ID:
    // contractId: "C...",
  },
  // Optional: pin the fee sponsor. Defaults to the server's configured sponsor.
  // feeSponsor: "G...",
});
```

Add the environment variable to `.env.local`:

```bash
# .env.local
VITE_LUMEN_COSIGNER_URL=http://localhost:8787
```

---

## 5. Wrap the App in `LumenProvider`

`LumenProvider` gives every component access to the client, the connected smart account, and the signing context.

```tsx
// src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { LumenProvider } from "@lumen/web-sdk/react";
import { lumen } from "./lumen";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LumenProvider client={lumen}>
      <App />
    </LumenProvider>
  </React.StrictMode>
);
```

---

## 6. Build the Payment UI with `useSendPayment`

`useSendPayment` handles the whole flow: it builds the payment operation, asks the user's signer to sign the intent, sends it to the cosigner, and returns the transaction hash.

```tsx
// src/App.tsx
import { useState } from "react";
import { useLumenAccount, useSendPayment } from "@lumen/web-sdk/react";

export default function App() {
  const { account, connect, isConnected } = useLumenAccount();
  const { sendPayment, status, error, txHash } = useSendPayment();

  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("1");

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    await sendPayment({
      destination,
      amount,
      asset: "XLM", // or { code: "USDC", issuer: "G..." }
      memo: "gasless-demo",
    });
  }

  if (!isConnected) {
    return (
      <main style={{ padding: 24 }}>
        <h1>Gasless dApp</h1>
        <p>Connect a smart account to get started.</p>
        <button onClick={() => connect()}>Connect</button>
      </main>
    );
  }

  return (
    <main style={{ padding: 24, maxWidth: 480 }}>
      <h1>Gasless dApp</h1>
      <p>
        Smart account: <code>{account?.contractId}</code>
      </p>

      <form onSubmit={handleSend} style={{ display: "grid", gap: 12 }}>
        <label>
          Destination
          <input
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="G..."
            required
          />
        </label>
        <label>
          Amount (XLM)
          <input
            type="number"
            min="0.0000001"
            step="0.0000001"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={status === "pending"}>
          {status === "pending" ? "Sending…" : "Send gasless payment"}
        </button>
      </form>

      {status === "success" && (
        <p>
          ✅ Sent! Tx:{" "}
          <a
            href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            {txHash}
          </a>
        </p>
      )}
      {status === "error" && <p style={{ color: "crimson" }}>❌ {error?.message}</p>}
    </main>
  );
}
```

---

## 7. Run the Example

Start the Lumen server (in a separate terminal):

```bash
# from the lumen repo root
npm run dev:server
# → Lumen cosigner listening on http://localhost:8787
```

Start the dApp:

```bash
cd gasless-dapp
npm run dev
# → VITE ready at http://localhost:5173
```

Open `http://localhost:5173`, click **Connect**, and send a payment to any Testnet address. The user's balance should decrease by the payment amount only — **no fee is deducted**.

---

## 8. Verification Checklist

Run through this list to confirm the tutorial worked end-to-end from a fresh clone:

- [ ] `npm install` completes in both `lumen/` and `gasless-dapp/`.
- [ ] `npm run dev:server` starts the cosigner and logs a sponsor public key.
- [ ] `npm run dev` serves the dApp at `http://localhost:5173`.
- [ ] Clicking **Connect** creates (or attaches to) a smart account and shows its contract ID.
- [ ] Submitting a payment returns a `txHash` and shows a success message.
- [ ] The transaction is visible on [Stellar Expert (Testnet)](https://stellar.expert/explorer/testnet) and is a **fee-bump** transaction.
- [ ] The user's account balance decreases by exactly the payment amount (no fee).
- [ ] The sponsor account's balance decreases by the network fee.
- [ ] Sending to an invalid destination surfaces a clear error in the UI.

If any step fails, check the [Gasless Transactions guide](../guides/gasless-transactions.md#troubleshooting) for common issues (cosigner URL, sponsor funding, network mismatch).

---

## Next Steps

- **Deploy a Soroban smart account** for production: see [Deploying a Soroban Smart Account](./deploying-soroban-smart-account.md).
- **Restrict what the cosigner will sponsor** with custom policy rules: see [Writing Custom Policy Rules](./writing-custom-policy-rules.md).
- **Read the deep dive** on fee-bump mechanics and intent signing: [Gasless Transactions](../guides/gasless-transactions.md).

---

*Part of the Lumen developer onboarding series. Found a bug? Open an issue referencing `#312`.*