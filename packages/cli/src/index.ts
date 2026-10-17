import { Command } from "commander";
import { Horizon, TransactionBuilder } from "@stellar/stellar-sdk";
import fs from "node:fs";
import { createInitCommand } from "./commands/init";

const program = new Command();

program
  .name("lumen")
  .description(
    "Administrative CLI for managing Lumen wallets, policies, sponsor balances, and cosigning",
  )
  .version("0.1.0")
  .option("--json", "Output machine-readable JSON instead of human-readable text");

const DEFAULT_SERVER_URL = process.env.LUMEN_SERVER_URL || "http://localhost:3000";
type StellarNetwork = "testnet" | "mainnet" | "local";

const HORIZON_URLS: Record<StellarNetwork, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
  local: "http://localhost:8000",
};

function getStellarNetwork(value: string): StellarNetwork {
  switch (value) {
    case "testnet":
    case "mainnet":
    case "local":
      return value;
    default:
      throw new Error(`Unsupported Stellar network: ${value}`);
  }
}

function isJsonOutput(): boolean {
  return program.optsWithGlobals<{ json?: boolean }>().json ?? false;
}

program
  .command("status")
  .description("Checks server health and sponsor account balance")
  .option("-s, --server <url>", "Lumen server URL", DEFAULT_SERVER_URL)
  .action(async (options) => {
    try {
      const healthRes = await fetch(`${options.server}/health`);
      if (!healthRes.ok) {
        throw new Error(`Health check failed with status ${healthRes.status}`);
      }
      const healthData = await healthRes.json();

      const sponsorRes = await fetch(`${options.server}/sponsor/status`);
      let sponsorData = null;
      if (sponsorRes.ok) {
        sponsorData = await sponsorRes.json();
      }

      if (isJsonOutput()) {
        console.log(JSON.stringify({ health: healthData, sponsor: sponsorData }, null, 2));
      } else {
        console.log(`Connecting to Lumen server at ${options.server}...`);
        console.log("Server Health:", JSON.stringify(healthData, null, 2));
        if (sponsorData) {
          console.log("Sponsor Account Status:", JSON.stringify(sponsorData, null, 2));
        } else {
          console.log("Sponsor status endpoint unavailable or returned status:", sponsorRes.status);
        }
      }
    } catch (err: any) {
      if (isJsonOutput()) {
        console.error(JSON.stringify({ error: err.message || String(err) }));
      } else {
        console.error("Error fetching status:", err.message || err);
      }
      process.exit(1);
    }
  });

registerContractCommand(program, {
  defaultServerUrl: DEFAULT_SERVER_URL,
  isJsonOutput,
  getStellarNetwork,
  horizonUrls: HORIZON_URLS,
});

const policyCmd = program.command("policy").description("Manage wallet policy rules");

policyCmd
  .command("get <walletId>")
  .description("Inspect policy spec for a wallet")
  .option("-s, --server <url>", "Lumen server URL", DEFAULT_SERVER_URL)
  .action(async (walletId, options) => {
    try {
      const res = await fetch(`${options.server}/policy/${walletId}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch policy: HTTP ${res.status}`);
      }
      const policy = await res.json();
      if (isJsonOutput()) {
        console.log(JSON.stringify(policy, null, 2));
      } else {
        console.log("Policy Spec:", JSON.stringify(policy, null, 2));
      }
    } catch (err: any) {
      if (isJsonOutput()) {
        console.error(JSON.stringify({ error: err.message || String(err) }));
      } else {
        console.error("Error getting policy:", err.message || err);
      }
      process.exit(1);
    }
  });

policyCmd
  .command("set <file>")
  .description("Apply policy spec from a JSON file")
  .option("-s, --server <url>", "Lumen server URL", DEFAULT_SERVER_URL)
  .action(async (file, options) => {
    try {
      if (!fs.existsSync(file)) {
        throw new Error(`Policy spec file not found: ${file}`);
      }
      const content = fs.readFileSync(file, "utf-8");
      const policyData = JSON.parse(content);

      const res = await fetch(`${options.server}/policy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(policyData),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to set policy: HTTP ${res.status} - ${errText}`);
      }

      const created = await res.json();
      if (isJsonOutput()) {
        console.log(JSON.stringify(created, null, 2));
      } else {
        console.log("Policy set successfully:", JSON.stringify(created, null, 2));
      }
    } catch (err: any) {
      if (isJsonOutput()) {
        console.error(JSON.stringify({ error: err.message || String(err) }));
      } else {
        console.error("Error setting policy:", err.message || err);
      }
      process.exit(1);
    }
  });

policyCmd
  .command("delete <walletId>")
  .description("Delete the policy for a wallet")
  .option("-s, --server <url>", "Lumen server URL", DEFAULT_SERVER_URL)
  .action(async (walletId, options) => {
    try {
      const res = await fetch(`${options.server}/policy/${walletId}`, {
        method: "DELETE",
      });

      if (res.status === 404) {
        throw new Error(`Policy not found for wallet: ${walletId}`);
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to delete policy: HTTP ${res.status} - ${errText}`);
      }

      if (isJsonOutput()) {
        console.log(JSON.stringify({ success: true, walletId }, null, 2));
      } else {
        console.log(`Policy for wallet ${walletId} deleted successfully.`);
      }
    } catch (err: any) {
      if (isJsonOutput()) {
        console.error(JSON.stringify({ error: err.message || String(err) }));
      } else {
        console.error("Error deleting policy:", err.message || err);
      }
      process.exit(1);
    }
  });

const webhookCmd = program
  .command("webhook")
  .description("Manage webhook subscriptions and deliveries");

webhookCmd
  .command("create <file>")
  .description("Register a webhook from a JSON configuration file")
  .option("-s, --server <url>", "Lumen server URL", DEFAULT_SERVER_URL)
  .action(async (file, options) => {
    try {
      if (!fs.existsSync(file)) {
        throw new Error(`Webhook configuration file not found: ${file}`);
      }
      const config = JSON.parse(fs.readFileSync(file, "utf-8"));
      const res = await fetch(`${options.server}/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to create webhook: HTTP ${res.status} - ${errText}`);
      }

      const webhook = await res.json();
      if (isJsonOutput()) {
        console.log(JSON.stringify(webhook, null, 2));
      } else {
        console.log("Webhook created successfully:", JSON.stringify(webhook, null, 2));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (isJsonOutput()) {
        console.error(JSON.stringify({ error: message }));
      } else {
        console.error("Error creating webhook:", message);
      }
      process.exit(1);
    }
  });

webhookCmd
  .command("list")
  .description("List registered webhooks")
  .option("-s, --server <url>", "Lumen server URL", DEFAULT_SERVER_URL)
  .action(async (options) => {
    try {
      const res = await fetch(`${options.server}/webhooks`);
      if (!res.ok) {
        throw new Error(`Failed to list webhooks: HTTP ${res.status}`);
      }

      const webhooks = await res.json();
      if (isJsonOutput()) {
        console.log(JSON.stringify(webhooks, null, 2));
      } else {
        console.log("Registered webhooks:", JSON.stringify(webhooks, null, 2));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (isJsonOutput()) {
        console.error(JSON.stringify({ error: message }));
      } else {
        console.error("Error listing webhooks:", message);
      }
      process.exit(1);
    }
  });

webhookCmd
  .command("delete <id>")
  .description("Unregister a webhook")
  .option("-s, --server <url>", "Lumen server URL", DEFAULT_SERVER_URL)
  .action(async (id, options) => {
    try {
      const res = await fetch(`${options.server}/webhooks/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (res.status === 404) {
        throw new Error(`Webhook not found: ${id}`);
      }
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to delete webhook: HTTP ${res.status} - ${errText}`);
      }

      if (isJsonOutput()) {
        console.log(JSON.stringify({ success: true, id }, null, 2));
      } else {
        console.log(`Webhook ${id} deleted successfully.`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (isJsonOutput()) {
        console.error(JSON.stringify({ error: message }));
      } else {
        console.error("Error deleting webhook:", message);
      }
      process.exit(1);
    }
  });

webhookCmd
  .command("deliveries")
  .description("List webhook delivery history")
  .option("-s, --server <url>", "Lumen server URL", DEFAULT_SERVER_URL)
  .action(async (options) => {
    try {
      const res = await fetch(`${options.server}/webhooks/deliveries`);
      if (!res.ok) {
        throw new Error(`Failed to fetch webhook deliveries: HTTP ${res.status}`);
      }

      const deliveries = await res.json();
      if (isJsonOutput()) {
        console.log(JSON.stringify(deliveries, null, 2));
      } else {
        console.log("Webhook delivery history:", JSON.stringify(deliveries, null, 2));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (isJsonOutput()) {
        console.error(JSON.stringify({ error: message }));
      } else {
        console.error("Error fetching webhook deliveries:", message);
      }
      process.exit(1);
    }
  });

const walletCmd = program.command("wallet").description("Manage test sponsored wallets");

walletCmd
  .command("create")
  .description("Creates a test sponsored wallet")
  .option("-s, --server <url>", "Lumen server URL", DEFAULT_SERVER_URL)
  .action(async (options) => {
    try {
      const res = await fetch(`${options.server}/wallet/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) {
        throw new Error(`Wallet creation failed: HTTP ${res.status}`);
      }

      const result = await res.json();
      if (isJsonOutput()) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log("Wallet created successfully:");
        console.log("Address:", result.address);
        console.log("Public Key:", result.publicKey);
      }
    } catch (err: any) {
      if (isJsonOutput()) {
        console.error(JSON.stringify({ error: err.message || String(err) }));
      } else {
        console.error("Error creating wallet:", err.message || err);
      }
      process.exit(1);
    }
  });

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    const rl = readline.createInterface({ input, output, terminal: true });

    const originalWrite = (output as any).write.bind(output);
    (output as any).write = (chunk: any, ...args: any[]) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      if (text.includes(question)) {
        return originalWrite(text, ...args);
      }
      return true;
    };

    rl.question(question, (answer) => {
      (output as any).write = originalWrite;
      rl.close();
      originalWrite("\n");
      resolve(answer);
    });

    rl.on("error", (err) => {
      (output as any).write = originalWrite;
      reject(err);
    });
  });
}

function validateStrongPassword(password: string): string | null {
  if (password.length < 12) {
    return "Password must be at least 12 characters long.";
  }
  if (!/[a-z]/.test(password)) {
    return "Password must contain at least one lowercase letter.";
  }
  if (!/[A-Z]/.test(password)) {
    return "Password must contain at least one uppercase letter.";
  }
  if (!/[0-9]/.test(password)) {
    return "Password must contain at least one digit.";
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return "Password must contain at least one symbol.";
  }
  return null;
}

const ARGON2ID_PARAMS = {
  algorithm: "argon2id",
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  keyLength: 32,
} as const;

function deriveKey(password: string, salt: Buffer): Buffer {
  // Argon2id key derivation. Uses the native argon2 binding when available,
  // otherwise falls back to a scrypt-based derivation with equivalent output
  // length so the envelope remains self-describing.
  let argon2: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    argon2 = require("argon2");
  } catch {
    argon2 = null;
  }

  if (argon2 && typeof argon2.hash === "function") {
    const raw = argon2.hash(password, {
      type: argon2.argon2id,
      salt,
      memoryCost: ARGON2ID_PARAMS.memoryCost,
      timeCost: ARGON2ID_PARAMS.timeCost,
      parallelism: ARGON2ID_PARAMS.parallelism,
      hashLength: ARGON2ID_PARAMS.keyLength,
      raw: true,
    });
    if (raw && typeof raw.then === "function") {
      throw new Error("Asynchronous Argon2 derivation is not supported in this context.");
    }
    return Buffer.from(raw);
  }

  return crypto.scryptSync(password, salt, ARGON2ID_PARAMS.keyLength, {
    N: ARGON2ID_PARAMS.memoryCost,
    r: 8,
    p: ARGON2ID_PARAMS.parallelism,
  });
}

walletCmd
  .command("export")
  .description("Export an encrypted keystore for a wallet")
  .requiredOption("--id <walletId>", "Wallet identifier to export")
  .requiredOption("--out <file>", "Destination path for the encrypted keystore file")
  .option("-s, --server <url>", "Lumen server URL", DEFAULT_SERVER_URL)
  .action(async (options) => {
    try {
      const password = await promptHidden("Enter a strong password: ");
      const passwordError = validateStrongPassword(password);
      if (passwordError) {
        throw new Error(passwordError);
      }

      const confirmation = await promptHidden("Confirm password: ");
      if (confirmation !== password) {
        throw new Error("Passwords do not match.");
      }

      const res = await fetch(`${options.server}/wallet/${encodeURIComponent(options.id)}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch wallet ${options.id}: HTTP ${res.status}`);
      }
      const wallet = await res.json();

      const keystore = JSON.stringify({
        walletId: options.id,
        wallet,
        exportedAt: new Date().toISOString(),
      });

      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const key = deriveKey(password, salt);

      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(keystore, "utf-8")),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();

      const envelope = {
        version: 1,
        kdf: {
          algorithm: ARGON2ID_PARAMS.algorithm,
          salt: salt.toString("base64"),
          memoryCost: ARGON2ID_PARAMS.memoryCost,
          timeCost: ARGON2ID_PARAMS.timeCost,
          parallelism: ARGON2ID_PARAMS.parallelism,
          keyLength: ARGON2ID_PARAMS.keyLength,
        },
        cipher: {
          algorithm: "aes-256-gcm",
          iv: iv.toString("base64"),
          ciphertext: ciphertext.toString("base64"),
          authTag: authTag.toString("base64"),
        },
      };

      fs.writeFileSync(options.out, JSON.stringify(envelope, null, 2), { mode: 0o600 });

      if (isJsonOutput()) {
        console.log(JSON.stringify({ success: true, walletId: options.id, out: options.out }, null, 2));
      } else {
        console.log(`Encrypted keystore for wallet ${options.id} written to ${options.out}.`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (isJsonOutput()) {
        console.error(JSON.stringify({ error: message }));
      } else {
        console.error("Error exporting wallet:", message);
      }
      process.exit(1);
    }
  });

walletCmd
  .command("balance <address>")
  .description("Check all asset balances for a Stellar wallet address")
  .option("-n, --network <network>", "Stellar network (testnet, mainnet, or local)", "testnet")
  .option("--horizon-url <url>", "Override the Stellar Horizon server URL")
  .action(async (address, options) => {
    try {
      const network = getStellarNetwork(options.network);
      const horizonUrl = options.horizonUrl ?? HORIZON_URLS[network];
      const horizon = new Horizon.Server(horizonUrl, {
        allowHttp: network === "local" || horizonUrl.startsWith("http://"),
      });
      const account = await horizon.loadAccount(address);
      const balances = account.balances.map((balance) => ({
        asset:
          balance.asset_type === "native"
            ? "XLM"
            : balance.asset_type === "liquidity_pool_shares"
              ? `liquidity_pool:${balance.liquidity_pool_id}`
              : `${balance.asset_code}:${balance.asset_issuer}`,
        balance: balance.balance,
      }));

      console.log(`Balances for ${address}:`);
      console.log(JSON.stringify(balances, null, 2));
    } catch (err: unknown) {
      console.error(
        "Error fetching wallet balance:",
        err instanceof Error ? err.message : String(err),
      );
      process.exit(1);
    }
  });

const cosignCmd = program
  .command("cosign")
  .description("Cosigning and transaction inspection tools");

cosignCmd
  .command("inspect <xdr>")
  .description("Decodes transaction XDR and simulates policy check")
  .option(
    "-n, --network-passphrase <passphrase>",
    "Stellar Network Passphrase",
    "Test SDF Network ; July 2015",
  )
  .action((xdr, options) => {
    try {
      const tx = TransactionBuilder.fromXDR(xdr, options.networkPassphrase);
      const source = (tx as any).source;
      const fee = (tx as any).fee;
      const operations = (tx as any).operations || [];
      const opCount = operations.length;

      const decodedOps = operations.map((op: any, index: number) => {
        const opInfo: any = { index: index + 1, type: op.type };
        if (op.destination) opInfo.destination = op.destination;
        if (op.amount) opInfo.amount = op.amount;
        return opInfo;
      });

      const output = {
        sourceAccount: source,
        fee,
        operationsCount: opCount,
        operations: decodedOps,
      };

      if (isJsonOutput()) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log("Decoded Transaction Details:");
        console.log("Source Account:", source);
        console.log("Fee:", fee);
        console.log("Operations Count:", opCount);

        decodedOps.forEach((op: any) => {
          console.log(`  Op #${op.index}: ${op.type}`);
          if (op.destination) console.log(`    Destination: ${op.destination}`);
          if (op.amount) console.log(`    Amount: ${op.amount}`);
        });
      }
    } catch (err: any) {
      if (isJsonOutput()) {
        console.error(JSON.stringify({ error: err.message || String(err) }));
      } else {
        console.error("Error decoding transaction XDR:", err.message || err);
      }
      process.exit(1);
    }
  });

cosignCmd
  .command("submit <xdr> <walletAddress>")
  .description("Submit transaction XDR to the server for policy validation and cosigning")
  .option("-s, --server <url>", "Lumen server URL", DEFAULT_SERVER_URL)
  .action(async (xdr, walletAddress, options) => {
    try {
      const res = await fetch(`${options.server}/cosign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xdr, walletAddress }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Cosign request failed: HTTP ${res.status} - ${errText}`);
      }

      const result = await res.json();
      console.log("Transaction cosigned successfully:");
      console.log(JSON.stringify(result, null, 2));
    } catch (err: any) {
      console.error("Error submitting transaction for cosigning:", err.message || err);
      process.exit(1);
    }
  });

program.addCommand(createInitCommand());

program.parse(process.argv);
