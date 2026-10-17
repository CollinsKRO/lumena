import { createServer } from "./server.js";
import { EnvSigner, AwsKmsSigner } from "./signers/index.js";
import type { Signer } from "@lumen/types";
import { logger } from "./logger.js";

/**
 * SIGNER_PROVIDER controls how private keys are accessed:
 *
 *   env     (default) — raw secrets from COSIGNER_SECRET / FEE_PAYER_SECRET.
 *                       Fine for local development and testnet.
 *                       ⚠  Do NOT use in production with real user funds.
 *
 *   awskms  (recommended for production) — keys live inside AWS KMS / CloudHSM.
 *                       Set KMS_COSIGNER_KEY_ID, KMS_FEE_PAYER_KEY_ID, and
 *                       KMS_REGION.  Requires @aws-sdk/client-kms and IAM
 *                       permissions; see AwsKmsSigner.ts for details.
 *
 * See docs/production-key-management.md for the full production checklist.
 */
const signerProvider = (process.env.SIGNER_PROVIDER ?? "env").toLowerCase();

async function buildSigners(): Promise<{ cosigner: Signer; feePayer: Signer }> {
  if (signerProvider === "awskms") {
    logger.info("Using AWS KMS signers (SIGNER_PROVIDER=awskms)");
    const [cosigner, feePayer] = await Promise.all([
      AwsKmsSigner.fromEnv("KMS_COSIGNER_KEY_ID"),
      AwsKmsSigner.fromEnv("KMS_FEE_PAYER_KEY_ID"),
    ]);
    return { cosigner, feePayer };
  }

  // Default: env-based signers (dev / testnet).
  if (signerProvider !== "env") {
    logger.warn(
      `Unknown SIGNER_PROVIDER="${signerProvider}", falling back to "env". ` +
        "Valid values: env, awskms.",
    );
  }

  const cosignerSecret = process.env.COSIGNER_SECRET;
  const feePayerSecret = process.env.FEE_PAYER_SECRET;

  if (!cosignerSecret || !feePayerSecret) {
    logger.error(
      "Missing COSIGNER_SECRET or FEE_PAYER_SECRET.\n" +
        "For production, set SIGNER_PROVIDER=awskms and configure KMS keys.\n" +
        "See docs/production-key-management.md.",
    );
    process.exit(1);
  }

  return {
    cosigner: new EnvSigner(cosignerSecret),
    feePayer: new EnvSigner(feePayerSecret),
  };
}

const { cosigner, feePayer } = await buildSigners();

/** Parse a comma-separated list of URLs, trimming blanks and duplicates. */
function parseUrlList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const urls = raw
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  return urls.length > 0 ? Array.from(new Set(urls)) : undefined;
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// Multi-region endpoint pools (issue #240). HORIZON_URLS / SOROBAN_RPC_URLS
// take precedence over the single-endpoint HORIZON_URL / SOROBAN_RPC_URL.
const horizonUrls = parseUrlList(process.env.HORIZON_URLS);
const rpcUrls = parseUrlList(process.env.SOROBAN_RPC_URLS);

// Fraud detection tuning (issue #241).
const fraudMaxRiskScore = parseOptionalNumber(process.env.FRAUD_MAX_RISK_SCORE);
const fraudVelocityMultiplier = parseOptionalNumber(
  process.env.FRAUD_VELOCITY_MULTIPLIER,
);

// Relational persistence (issue #242). When DATABASE_URL is set we back the
// policy engine and wallet registry with Prisma/PostgreSQL instead of Redis.
const databaseUrl = process.env.DATABASE_URL;
let policyStore: import("./db/index.js").PrismaPolicyStore | undefined;
if (databaseUrl) {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPolicyStore } = await import("./db/index.js");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  policyStore = new PrismaPolicyStore(prisma);
  logger.info("Using Prisma/PostgreSQL persistence (DATABASE_URL set)");
}

createServer({
  port: parseInt(process.env.PORT ?? "3000"),
  network: (process.env.STELLAR_NETWORK as any) ?? "testnet",
  horizonUrl: process.env.HORIZON_URL,
  rpcUrl: process.env.SOROBAN_RPC_URL,
  horizonUrls,
  rpcUrls,
  fraudMaxRiskScore,
  fraudVelocityMultiplier,
  policyStore,
  walletRegistry: policyStore,
  cosignerSigner: cosigner,
  feePayerSigner: feePayer,
  apiKey: process.env.API_KEY,
  windowMs: process.env.RATE_LIMIT_WINDOW_MS
    ? parseInt(process.env.RATE_LIMIT_WINDOW_MS)
    : undefined,
  max: process.env.RATE_LIMIT_MAX ? parseInt(process.env.RATE_LIMIT_MAX) : undefined,
});
