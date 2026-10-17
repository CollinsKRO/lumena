"use client";

import { LumenProvider, LumenThemeProvider, useWallet } from "@lumen/react";
import { LumenClient } from "@lumen/web-sdk";

const client = new LumenClient({
  serverUrl: process.env.NEXT_PUBLIC_LUMEN_SERVER_URL ?? "http://localhost:3000",
});

function WalletPanel() {
  const wallet = useWallet();
  return (
    <main>
      <button onClick={() => void wallet.createWallet()}>Create wallet</button>
      <pre>{JSON.stringify({ address: wallet.wallet?.address, error: wallet.error?.message }, null, 2)}</pre>
    </main>
  );
}

export default function Page() {
  return (
    <LumenProvider client={client}>
      <LumenThemeProvider>
        <WalletPanel />
      </LumenThemeProvider>
    </LumenProvider>
  );
}