import { test, expect } from '@playwright/test';
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
  Account,
  Transaction,
  FeeBumpTransaction,
} from '@stellar/stellar-sdk';

/**
 * E2E specs for issue #304.
 *
 * These specs exercise multisig setup, co-signing, fee-bump submission and
 * ledger confirmation against a local Stellar quickstart container
 * (`stellar/quickstart:testing`) started by the CI workflow.
 *
 * The Horizon and Soroban RPC endpoints are provided through environment
 * variables so the suite can run both locally and in CI:
 *   - E2E_HORIZON_URL (default: http://localhost:8000)
 *   - E2E_RPC_URL     (default: http://localhost:8000/soroban/rpc)
 *   - E2E_NETWORK_PASSPHRASE (default: Standalone Network ; February 2017)
 */

const HORIZON_URL = process.env.E2E_HORIZON_URL ?? 'http://localhost:8000';
const NETWORK_PASSPHRASE =
  process.env.E2E_NETWORK_PASSPHRASE ?? Networks.STANDALONE;

const FRIENDBOT_URL = `${HORIZON_URL}/friendbot`;

interface HorizonAccountResponse {
  id: string;
  account_id: string;
  sequence: string;
  signers: Array<{ key: string; weight: number; type: string }>;
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
}

interface HorizonSubmitResponse {
  hash: string;
  ledger: number;
  successful: boolean;
}

async function fundAccount(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) {
    throw new Error(`Friendbot funding failed for ${publicKey}: ${res.status} ${await res.text()}`);
  }
}

async function getAccount(publicKey: string): Promise<HorizonAccountResponse> {
  const res = await fetch(`${HORIZON_URL}/accounts/${publicKey}`);
  if (!res.ok) {
    throw new Error(`Failed to load account ${publicKey}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as HorizonAccountResponse;
}

async function submitTransaction(
  tx: Transaction | FeeBumpTransaction,
): Promise<HorizonSubmitResponse> {
  const body = new URLSearchParams({ tx: tx.toEnvelope().toXDR('base64') });
  const res = await fetch(`${HORIZON_URL}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await res.json()) as HorizonSubmitResponse & {
    extras?: { result_codes?: unknown };
  };
  if (!res.ok) {
    throw new Error(
      `Transaction submission failed: ${res.status} ${JSON.stringify(json.extras ?? json)}`,
    );
  }
  return json;
}

async function waitForLedger(ledger: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${HORIZON_URL}/ledgers/${ledger}`);
    if (res.ok) {
      const body = (await res.json()) as { sequence: number; closed_at: string };
      if (body.sequence === ledger && body.closed_at) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Ledger ${ledger} was not confirmed within ${timeoutMs}ms`);
}

async function buildAccount(publicKey: string): Promise<Account> {
  const account = await getAccount(publicKey);
  return new Account(account.account_id, account.sequence);
}

test.describe('Stellar multisig E2E (issue #304)', () => {
  test.describe.configure({ mode: 'serial' });

  test('multisig setup: add a co-signer and update thresholds', async () => {
    const master = Keypair.random();
    const coSigner = Keypair.random();

    await fundAccount(master.publicKey());

    const source = await buildAccount(master.publicKey());

    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.setOptions({
          signer: {
            ed25519PublicKey: coSigner.publicKey(),
            weight: 1,
          },
          masterWeight: 1,
          lowThreshold: 1,
          medThreshold: 2,
          highThreshold: 2,
        }),
      )
      .setTimeout(30)
      .build();

    tx.sign(master);

    const result = await submitTransaction(tx);
    expect(result.successful).toBe(true);
    expect(result.hash).toBeTruthy();

    await waitForLedger(result.ledger);

    const updated = await getAccount(master.publicKey());
    const signerKeys = updated.signers.map((s) => s.key);
    expect(signerKeys).toContain(master.publicKey());
    expect(signerKeys).toContain(coSigner.publicKey());
    expect(updated.thresholds.med_threshold).toBe(2);
    expect(updated.thresholds.high_threshold).toBe(2);
  });

  test('co-signing flow: transaction requires both signatures before submission', async () => {
    const master = Keypair.random();
    const coSigner = Keypair.random();

    await fundAccount(master.publicKey());

    // Configure multisig: master weight 1, co-signer weight 1, med threshold 2.
    {
      const source = await buildAccount(master.publicKey());
      const setupTx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.setOptions({
            signer: { ed25519PublicKey: coSigner.publicKey(), weight: 1 },
            masterWeight: 1,
            lowThreshold: 1,
            medThreshold: 2,
            highThreshold: 2,
          }),
        )
        .setTimeout(30)
        .build();
      setupTx.sign(master);
      const setupResult = await submitTransaction(setupTx);
      expect(setupResult.successful).toBe(true);
      await waitForLedger(setupResult.ledger);
    }

    // Build a payment that requires the medium threshold (2 signatures).
    const source = await buildAccount(master.publicKey());
    const paymentTx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.payment({
          destination: coSigner.publicKey(),
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build();

    // Only the master signs first — submission must fail with tx_bad_auth.
    paymentTx.sign(master);
    await expect(submitTransaction(paymentTx)).rejects.toThrow(/tx_bad_auth/);

    // Co-signer adds their signature; the transaction should now succeed.
    paymentTx.sign(coSigner);
    const result = await submitTransaction(paymentTx);
    expect(result.successful).toBe(true);
    await waitForLedger(result.ledger);

    const destination = await getAccount(coSigner.publicKey());
    expect(destination.account_id).toBe(coSigner.publicKey());
  });

  test('fee-bump submission: inner transaction is sponsored and confirmed', async () => {
    const sponsor = Keypair.random();
    const source = Keypair.random();
    const destination = Keypair.random();

    await fundAccount(sponsor.publicKey());
    await fundAccount(source.publicKey());

    const sourceAccount = await buildAccount(source.publicKey());

    const innerTx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.payment({
          destination: destination.publicKey(),
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build();

    innerTx.sign(source);

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      sponsor,
      (BigInt(BASE_FEE) * 10n).toString(),
      innerTx,
      NETWORK_PASSPHRASE,
    );
    feeBumpTx.sign(sponsor);

    const result = await submitTransaction(feeBumpTx);
    expect(result.successful).toBe(true);
    expect(result.hash).toBeTruthy();

    await waitForLedger(result.ledger);

    // Confirm the inner transaction hash is recorded on Horizon.
    const innerRes = await fetch(`${HORIZON_URL}/transactions/${innerTx.hash().toString('hex')}`);
    expect(innerRes.ok).toBe(true);
    const innerBody = (await innerRes.json()) as { successful: boolean; ledger: number };
    expect(innerBody.successful).toBe(true);
    expect(innerBody.ledger).toBe(result.ledger);
  });

  test('ledger confirmation: submitted transaction is included in a closed ledger', async () => {
    const source = Keypair.random();
    const destination = Keypair.random();

    await fundAccount(source.publicKey());

    const sourceAccount = await buildAccount(source.publicKey());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.payment({
          destination: destination.publicKey(),
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build();

    tx.sign(source);

    const result = await submitTransaction(tx);
    expect(result.successful).toBe(true);
    expect(result.ledger).toBeGreaterThan(0);

    await waitForLedger(result.ledger);

    const ledgerRes = await fetch(`${HORIZON_URL}/ledgers/${result.ledger}`);
    expect(ledgerRes.ok).toBe(true);
    const ledger = (await ledgerRes.json()) as { sequence: number; closed_at: string };
    expect(ledger.sequence).toBe(result.ledger);
    expect(ledger.closed_at).toBeTruthy();

    const txRes = await fetch(`${HORIZON_URL}/transactions/${result.hash}`);
    expect(txRes.ok).toBe(true);
    const txBody = (await txRes.json()) as { hash: string; ledger: number; successful: boolean };
    expect(txBody.hash).toBe(result.hash);
    expect(txBody.ledger).toBe(result.ledger);
    expect(txBody.successful).toBe(true);
  });
});