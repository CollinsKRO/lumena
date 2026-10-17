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
