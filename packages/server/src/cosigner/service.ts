import { TransactionBuilder, Transaction, Keypair, xdr } from "@stellar/stellar-sdk";
import type { Signer } from "@lumen/types";
import { validateTimeBounds, type StellarClient } from "@lumen/core";
import type { PolicyEngine } from "../policy/engine.js";
import type { WebhookDispatcher } from "../webhook/dispatcher.js";
import { trackOperation } from "../lifecycle.js";

export interface CosignerOpts {
  client: StellarClient;
  /** Production: use an AwsKmsSigner. Dev/testnet: use an EnvSigner. */
  signer: Signer;
  policyEngine: PolicyEngine;
  enforceTimeBounds?: boolean;
  maxValidityWindowSeconds?: number;
  webhookDispatcher?: WebhookDispatcher;
}

export interface CosignRequest {
  xdr: string;
  walletAddress: string;
}

export interface CosignResult {
  signedXdr: string;
  approved: boolean;
  reason?: string;
}

export class CosignerService {
  private client: StellarClient;
  private signer: Signer;
  private policyEngine: PolicyEngine;
  private enforceTimeBounds: boolean;
  private maxValidityWindowSeconds?: number;
  private webhookDispatcher?: WebhookDispatcher;

  constructor(opts: CosignerOpts) {
    this.client = opts.client;
    this.signer = opts.signer;
    this.policyEngine = opts.policyEngine;
    this.enforceTimeBounds = opts.enforceTimeBounds ?? false;
    this.maxValidityWindowSeconds = opts.maxValidityWindowSeconds;
    this.webhookDispatcher = opts.webhookDispatcher;
  }

  get publicKey(): string {
    return this.signer.publicKey();
  }

  async cosign(request: CosignRequest): Promise<CosignResult> {
    return trackOperation(() => this.cosignInternal(request));
  }

  private async cosignInternal(request: CosignRequest): Promise<CosignResult> {
    const parsed = TransactionBuilder.fromXDR(
      request.xdr,
      this.client.networkPassphrase
    );
    const tx = parsed instanceof Transaction ? parsed : null;

    if (!tx) {
      return {
        signedXdr: "",
        approved: false,
        reason:
          "Fee-bump transactions are not accepted for co-signing. Please submit a regular transaction.",
      };
    }

    if (tx.source !== request.walletAddress) {
      return {
        signedXdr: "",
        approved: false,
        reason: "Transaction source does not match wallet address",
      };
    }

    const txHash = tx.hash();
    let hasOwnerSignature = false;
    try {
      const ownerKeypair = Keypair.fromPublicKey(request.walletAddress);
      hasOwnerSignature = tx.signatures.some((sig) => {
        try {
          return ownerKeypair.verify(txHash, sig.signature());
        } catch {
          return false;
        }
      });
    } catch {
      hasOwnerSignature = false;
    }

    if (!hasOwnerSignature) {
      return {
        signedXdr: "",
        approved: false,
        reason: "Transaction is not signed by the wallet owner",
      };
    }

    if (this.enforceTimeBounds) {
      const tbCheck = validateTimeBounds(tx, {
        maxWindowSeconds: this.maxValidityWindowSeconds,
        allowUnbounded: false,
      });
      if (!tbCheck.valid) {
        return {
          signedXdr: "",
          approved: false,
          reason: tbCheck.reason ?? "Timebounds validation failed",
        };
      }
    }

    const policyResult = await this.policyEngine.evaluate({
      walletAddress: request.walletAddress,
      transaction: tx,
    });

    if (!policyResult.approved) {
      if (this.webhookDispatcher) {
        this.webhookDispatcher
          .dispatch("policy.violated", {
            walletAddress: request.walletAddress,
            reason: policyResult.reason,
            txHash: txHash.toString("hex"),
          })
          .catch(() => {});
      }

      return {
        signedXdr: "",
        approved: false,
        reason: policyResult.reason,
      };
    }

    // Sign using the abstracted Signer (KMS or env-keypair).
    const signature = await this.signer.sign(txHash);

    // Attach the signature to the transaction envelope using the decorated hint
    // format that Stellar expects: last 4 bytes of the raw public key.
    const rawPublicKey = Keypair.fromPublicKey(
      this.signer.publicKey()
    ).rawPublicKey();
    const hint = rawPublicKey.slice(-4);

    tx.signatures.push(
      new xdr.DecoratedSignature({
        hint,
        signature: Buffer.from(signature),
      })
    );

    if (this.webhookDispatcher) {
      this.webhookDispatcher
        .dispatch("transaction.cosigned", {
          walletAddress: request.walletAddress,
          txHash: txHash.toString("hex"),
        })
        .catch(() => {});
    }

    return {
      signedXdr: tx.toXDR(),
      approved: true,
    };
  }
}
