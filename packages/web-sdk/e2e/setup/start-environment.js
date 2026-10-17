import { spawn, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, rpc as sorobanRpc } from "@stellar/stellar-sdk";
import { createServer, EnvSigner } from "@lumen/server";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, "../../../..");
const DOCKER_COMPOSE_FILE = resolve(ROOT_DIR, "docker/docker-compose.yml");
const CONFIG_OUTPUT = resolve(__dirname, "../test-app/e2e-config.json");

const HORIZON_URL = process.env.HORIZON_URL ?? "http://localhost:8000";
const RPC_URL = process.env.RPC_URL ?? "http://localhost:8000/rpc";
const SERVER_PORT = 3000;
const VITE_PORT = 5173;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function isHorizonReady() {
  try {
    const res = await fetch(`${HORIZON_URL}/`);
    return res.ok;
  } catch {
    return false;
  }
}

async function isRpcReady() {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.result?.status === "healthy";
  } catch {
    return false;
  }
}

async function ensureStellarContainer() {
  console.log("[E2E Setup] Checking Stellar standalone container...");
  const ready = (await isHorizonReady()) && (await isRpcReady());
  if (ready) {
    console.log("[E2E Setup] Stellar container is already running and healthy.");
    return;
  }

  console.log("[E2E Setup] Starting Stellar container via docker compose...");
  try {
    execSync(`docker compose -f ${DOCKER_COMPOSE_FILE} up -d stellar`, {
      stdio: "inherit",
    });
  } catch (err) {
    console.warn("[E2E Setup] docker compose up failed, attempting docker run fallback...", err.message);
    execSync(
      "docker run -d --name lumen-stellar-e2e -p 8000:8000 -p 8080:8080 -p 6000:6000 stellar/quickstart:testing --local",
      { stdio: "inherit" }
    );
  }

  console.log("[E2E Setup] Waiting for Horizon and Soroban RPC to become healthy...");
  const startTime = Date.now();
  while (Date.now() - startTime < 120000) {
    if ((await isHorizonReady()) && (await isRpcReady())) {
      console.log("[E2E Setup] Horizon and Soroban RPC are ready!");
      return;
    }
    await sleep(1500);
  }
  throw new Error("Timed out waiting for Stellar quickstart container to be ready.");
}

async function main() {
  await ensureStellarContainer();

  console.log("[E2E Setup] Generating test Stellar keypairs...");
  const rpc = new sorobanRpc.Server(RPC_URL, { allowHttp: true });

  const sponsorKeypair = Keypair.random();
  const cosignerKeypair = Keypair.random();
  const feePayerKeypair = Keypair.random();
  const destinationKeypair = Keypair.random();
  // Additional fixtures for issue #304 E2E scenarios.
  const multisigSignerKeypair = Keypair.random();
  const coSignerKeypair = Keypair.random();
  const feeBumpSourceKeypair = Keypair.random();
  const ledgerConfirmationKeypair = Keypair.random();

  const fundedKeypairs = [
    ["sponsor", sponsorKeypair],
    ["fee-payer", feePayerKeypair],
    ["destination", destinationKeypair],
    ["multisig-signer", multisigSignerKeypair],
    ["co-signer", coSignerKeypair],
    ["fee-bump-source", feeBumpSourceKeypair],
    ["ledger-confirmation", ledgerConfirmationKeypair],
  ];

  for (const [label, keypair] of fundedKeypairs) {
    console.log(`[E2E Setup] Requesting airdrop for ${label}: ${keypair.publicKey()}`);
    await rpc.requestAirdrop(keypair.publicKey());
  }

  console.log("[E2E Setup] Writing e2e-config.json...");
  const config = {
    network: "local",
    horizonUrl: HORIZON_URL,
    rpcUrl: RPC_URL,
    serverUrl: `http://localhost:${SERVER_PORT}`,
    sponsorSecret: sponsorKeypair.secret(),
    sponsorPublicKey: sponsorKeypair.publicKey(),
    serverPublicKey: cosignerKeypair.publicKey(),
    destinationPublicKey: destinationKeypair.publicKey(),
    // Multisig setup fixtures.
    multisigSignerSecret: multisigSignerKeypair.secret(),
    multisigSignerPublicKey: multisigSignerKeypair.publicKey(),
    // Co-signing fixtures.
    coSignerSecret: coSignerKeypair.secret(),
    coSignerPublicKey: coSignerKeypair.publicKey(),
    // Fee-bump fixtures.
    feeBumpSourceSecret: feeBumpSourceKeypair.secret(),
    feeBumpSourcePublicKey: feeBumpSourceKeypair.publicKey(),
    feePayerSecret: feePayerKeypair.secret(),
    feePayerPublicKey: feePayerKeypair.publicKey(),
    // Ledger confirmation fixtures.
    ledgerConfirmationSecret: ledgerConfirmationKeypair.secret(),
    ledgerConfirmationPublicKey: ledgerConfirmationKeypair.publicKey(),
  };

  writeFileSync(CONFIG_OUTPUT, JSON.stringify(config, null, 2), "utf-8");
  console.log("[E2E Setup] Configuration written to:", CONFIG_OUTPUT);

  // Expose the environment variables consumed by the E2E specs (issue #304).
  process.env.E2E_NETWORK = config.network;
  process.env.E2E_HORIZON_URL = config.horizonUrl;
  process.env.E2E_RPC_URL = config.rpcUrl;
  process.env.E2E_SERVER_URL = config.serverUrl;
  process.env.E2E_SPONSOR_SECRET = config.sponsorSecret;
  process.env.E2E_SPONSOR_PUBLIC_KEY = config.sponsorPublicKey;
  process.env.E2E_SERVER_PUBLIC_KEY = config.serverPublicKey;
  process.env.E2E_DESTINATION_PUBLIC_KEY = config.destinationPublicKey;
  process.env.E2E_MULTISIG_SIGNER_SECRET = config.multisigSignerSecret;
  process.env.E2E_MULTISIG_SIGNER_PUBLIC_KEY = config.multisigSignerPublicKey;
  process.env.E2E_COSIGNER_SECRET = config.coSignerSecret;
  process.env.E2E_COSIGNER_PUBLIC_KEY = config.coSignerPublicKey;
  process.env.E2E_FEE_BUMP_SOURCE_SECRET = config.feeBumpSourceSecret;
  process.env.E2E_FEE_BUMP_SOURCE_PUBLIC_KEY = config.feeBumpSourcePublicKey;
  process.env.E2E_FEE_PAYER_SECRET = config.feePayerSecret;
  process.env.E2E_FEE_PAYER_PUBLIC_KEY = config.feePayerPublicKey;
  process.env.E2E_LEDGER_CONFIRMATION_SECRET = config.ledgerConfirmationSecret;
  process.env.E2E_LEDGER_CONFIRMATION_PUBLIC_KEY = config.ledgerConfirmationPublicKey;
  process.env.E2E_CONFIG_PATH = CONFIG_OUTPUT;

  console.log("[E2E Setup] Starting @lumen/server on port", SERVER_PORT);
  const serverResult = createServer({
    port: SERVER_PORT,
    network: "local",
    horizonUrl: HORIZON_URL,
    rpcUrl: RPC_URL,
    cosignerSigner: new EnvSigner(cosignerKeypair.secret()),
    feePayerSigner: new EnvSigner(feePayerKeypair.secret()),
  });

  console.log("[E2E Setup] Starting Vite dev server for test-app on port", VITE_PORT);
  const testAppDir = resolve(__dirname, "../test-app");
  const viteBin = resolve(__dirname, "../../node_modules/.bin/vite");
  const viteProcess = spawn(
    viteBin,
    [testAppDir, "--port", String(VITE_PORT), "--host", "0.0.0.0"],
    {
      stdio: "inherit",
      env: { ...process.env },
    }
  );

  const cleanup = () => {
    console.log("\n[E2E Setup] Shutting down Vite and Lumen server...");
    viteProcess.kill("SIGTERM");
    serverResult.sponsorMonitorService?.stop();
    serverResult.server.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  viteProcess.on("exit", (code) => {
    console.log(`[E2E Setup] Vite exited with code ${code}`);
    serverResult.server.close();
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error("[E2E Setup] Fatal error starting test environment:", err);
  process.exit(1);
});
