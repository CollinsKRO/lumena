import { TransactionBuilder, Transaction, Keypair, xdr } from "@stellar/stellar-sdk";
import type { Signer } from "@lumen/types";
import type { StellarClient } from "@lumen/core";
import type { WebhookDispatcher } from "../webhook/dispatcher.js";
import { trackOperation } from "../lifecycle.js";

export interface FeeSponsorOpts {
  client: StellarClient;
  /** Production: use an AwsKmsSigner. Dev/testnet: use an EnvSigner. */
  signer: Signer;
  baseFee?: string;
  webhookDispatcher?: WebhookDispatcher;
}

export class FeeSponsorService {
  private client: StellarClient;
  private signer: Signer;
  private baseFee: string;
  private webhookDispatcher?: WebhookDispatcher;

  constructor(opts: FeeSponsorOpts) {
    this.client = opts.client;
    this.signer = opts.signer;
    this.baseFee = opts.baseFee ?? "1000000";
    this.webhookDispatcher = opts.webhookDispatcher;
  }

  get publicKey(): string {
    return this.signer.publicKey();
  }

  async wrapFeeBump(innerTxXdr: string): Promise<string> {
    return trackOperation("fee-bump:wrap", async () => {
      const parsed = TransactionBuilder.fromXDR(innerTxXdr, this.client.networkPassphrase);
      const innerTx = parsed instanceof Transaction ? parsed : null;
      if (!innerTx) {
        throw new Error("Expected a regular transaction, not a fee-bump");
      }

      // Build the fee-bump envelope.  buildFeeBumpTransaction derives the
      // fee-source account from a Keypair; we create a public-key-only Keypair
      // so the private key is never needed here.  Signing uses our Signer
      // abstraction so the private key stays in KMS / never in memory.
      const feeSourceKeypair = Keypair.fromPublicKey(this.signer.publicKey());
      const feeBump = TransactionBuilder.buildFeeBumpTransaction(
        feeSourceKeypair,
        this.baseFee,
        innerTx,
        this.client.networkPassphrase,
      );

      // Sign via the abstracted Signer.
      const txHash = feeBump.hash();
      const signature = await this.signer.sign(txHash);
      const hint = feeSourceKeypair.rawPublicKey().slice(-4);

      feeBump.signatures.push(
        new xdr.DecoratedSignature({
          hint,
          signature: Buffer.from(signature),
        }),
      );

      return feeBump.toXDR();
    });
  }

  async submit(innerTxXdr: string): Promise<{ hash: string; feeBumpHash: string }> {
    return trackOperation("fee-bump:submit", async () => {
      const feeBumpXdr = await this.wrapFeeBump(innerTxXdr);
      const parsed = TransactionBuilder.fromXDR(feeBumpXdr, this.client.networkPassphrase);

      const result = await this.client.horizon.submitTransaction(parsed);

      if (!result.successful) {
        throw new Error(`Fee-bump submission failed: ${result.hash}`);
      }

      if (this.webhookDispatcher) {
        this.webhookDispatcher
          .dispatch("transaction.fee_bump.submitted", {
            feeSource: this.signer.publicKey(),
            hash: result.hash,
            feeBumpHash: result.hash,
          })
          .catch(() => {});

        this.webhookDispatcher
          .dispatch("transaction.sponsored", {
            feeSource: this.signer.publicKey(),
            hash: result.hash,
          })
          .catch(() => {});
      }

      return { hash: result.hash, feeBumpHash: result.hash };
    });
  }
}
