# @lumen/react

React context provider and hooks for integrating Lumen into React applications.

## Installation

```bash
pnpm add @lumen/react @lumen/web-sdk
```

## Quick Start

```tsx
import { LumenClient } from "@lumen/web-sdk";
import {
  LumenProvider,
  useWallet,
  useCreateWallet,
  useBalance,
  useSendPayment,
} from "@lumen/react";

const lumenClient = new LumenClient({
  network: "testnet",
  sponsorSecret: process.env.FEE_PAYER_SECRET!,
  serverPublicKey: process.env.COSIGNER_PUBLIC_KEY!,
});

function WalletBalance({ walletId }: { walletId: string }) {
  const { balance, loading, error } = useBalance(walletId, "USDC");

  if (loading) return <p>Loading balance...</p>;
  if (error) return <p>Error: {error.message}</p>;

  return <p>Balance: {balance}</p>;
}

function WalletDetails({ walletId }: { walletId: string }) {
  const { wallet, error } = useWallet(walletId);

  if (error) return <p>Error: {error.message}</p>;

  return <p>Address: {wallet?.address}</p>;
}

function CreateWalletButton() {
  const { createWallet, loading, error, data } = useCreateWallet();

  return (
    <>
      <button onClick={() => void createWallet()} disabled={loading}>
        {loading ? "Creating..." : "Create wallet"}
      </button>
      {error && <p>Error: {error.message}</p>}
      {data && <p>Wallet address: {data.address}</p>}
    </>
  );
}

function SendPaymentButton() {
  const { sendPayment, loading, error } = useSendPayment();

  async function handleSend() {
    await sendPayment({
      walletId: "wallet-id",
      destination: "destination-address",
      assetCode: "USDC",
      amount: "10",
    });
  }

  return (
    <>
      <button onClick={handleSend} disabled={loading}>
        {loading ? "Sending..." : "Send payment"}
      </button>
      {error && <p>Error: {error.message}</p>}
    </>
  );
}

export function App() {
  return (
    <LumenProvider client={lumenClient}>
      <CreateWalletButton />
      <WalletBalance walletId="wallet-id" />
      <WalletDetails walletId="wallet-id" />
      <SendPaymentButton />
    </LumenProvider>
  );
}
```

> **Security:** Keep `sponsorSecret` server-side. Do not expose it in browser bundles or commit it to source control.

## API

### `LumenProvider`

Provides a `LumenClient` instance to descendant components.

```tsx
<LumenProvider client={lumenClient}>
  {children}
</LumenProvider>
```

### `useLumen()`

Returns the Lumen client from the nearest `LumenProvider`.

```tsx
const { client } = useLumen();
```

Throws an error when used outside a `LumenProvider`.

### `useWallet(walletId)`

Returns the wallet associated with the supplied wallet ID.

```tsx
const { wallet, error, refetch } = useWallet(walletId);
```

### `useCreateWallet()`

Creates a wallet through the configured `LumenClient` and exposes loading, error, and result state.

```tsx
const { createWallet, loading, error, data, reset } = useCreateWallet();

const wallet = await createWallet();
console.log(wallet.address, wallet.id);
```

### `useBalance(walletId, assetCode?)`

Fetches a wallet balance and automatically refreshes it every 10 seconds by default.

```tsx
const { balance, loading, error, refetch } = useBalance(walletId, "USDC");
```

Pass a third argument to customize the refresh interval in milliseconds. Use `0` or a negative value to disable automatic refresh.

### `useSendPayment()`

Provides a function for sending a payment and exposes loading, error, and result state.

```tsx
const { sendPayment, loading, error, data, reset } = useSendPayment();

await sendPayment({
  walletId,
  destination,
  assetCode,
  amount,
});
```

### `useSessionKeyManager()`

Manages temporary session keys, tracking their time-to-live countdown, remaining spending quota, and providing instant revocation.

```tsx
const {
  sessionKeys,
  timeToLive,
  remainingQuota,
  revoke,
  loading,
  error,
} = useSessionKeyManager(walletId);

// timeToLive updates every second (in seconds)
// remainingQuota reflects the remaining spending budget for the active key

// Revoke a session key: removes the multisig signer / on-chain delegation
// via a co-signed transaction.
await revoke(sessionKeyAddress);
```

## Components

### `LumenQrScanner`

A camera-based QR scanner for destination addresses and SEP-0007 transaction URIs. It uses an HTML5 video stream, supports switching between cameras, and includes a flash toggle for devices that expose a torch.

```tsx
import { LumenQrScanner } from "@lumen/react";

<LumenQrScanner
  onScan={(result) => {
    // result.address: the parsed Stellar public key
    // result.uri: the raw scanned value
    // result.sep0007: parsed SEP-0007 payload when a web+stellar:pay link is scanned
    console.log(result);
  }}
  onError={(error) => console.error(error)}
/>;
```

The scanner parses standard Stellar public keys (`G...`) and `web+stellar:pay` links. When a valid code is detected, `onScan(result)` is invoked; camera or permission failures are reported through `onError`.

### `LumenThemeProvider`

Provides design tokens and dark/light/system theming to all prebuilt Lumen components without CSS conflicts.

```tsx
import { LumenThemeProvider } from "@lumen/react";

<LumenThemeProvider mode="system">
  <App />
</LumenThemeProvider>;
```

`mode` accepts `"dark"`, `"light"`, or `"system"` (follows the OS preference). Changing the mode dynamically updates colors across all prebuilt Lumen components.

Tokens are exposed as CSS variables and can be overridden to match host branding:

- `--lumen-primary`
- `--lumen-bg`
- `--lumen-card-bg`
- `--lumen-radius`

## Next.js App Router (RSC) Compatibility

`@lumen/react` is compatible with the Next.js 14+ App Router. All React entrypoints and interactive components include the `"use client"` directive, so they can be imported directly into client components without hydration mismatches.

For React Server Components, a server-safe mock provider is available so that server rendering does not attempt to access browser globals:

```tsx
import { LumenServerProvider } from "@lumen/react";

// Safe to use in a React Server Component
<LumenServerProvider>
  <App />
</LumenServerProvider>;
```

## Development

You can work on `@lumen/react` independently without running the full monorepo suite.

### Prerequisites

1. **Install Dependencies**: Install workspace dependencies at the monorepo root:
   ```bash
   pnpm install
   ```

2. **Build Dependent Packages**: Build the core dependencies (`@lumen/core` and `@lumen/web-sdk`):
   ```bash
   pnpm build
   ```

### Running in Development Mode

Run TypeScript in watch mode to automatically compile on file changes:

```bash
pnpm --filter @lumen/react dev
```

### Additional Package Scripts

From the repository root:

```bash
# Run unit tests with Vitest and React Testing Library
pnpm --filter @lumen/react test

# Check TypeScript types
pnpm --filter @lumen/react typecheck

# Lint source files
pnpm --filter @lumen/react lint

# Build production bundle
pnpm --filter @lumen/react build

# Clean build artifacts
pnpm --filter @lumen/react clean
```

## License

MIT
