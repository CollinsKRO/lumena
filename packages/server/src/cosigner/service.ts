import { TransactionBuilder, Transaction, Keypair, xdr } from "@stellar/stellar-sdk";
import type { Signer } from "@lumen/types";
import { validateTimeBounds, type StellarClient } from "@lumen/core";
import type { PolicyEngine } from "../policy/engine.js";
import type { WebhookDispatcher } from "../webhook/dispatcher.js";
import type { FraudDetector } from "../security/fraud-detector.js";

export interface CosignerOpts {
  client: StellarClient;
  /** Production: use an AwsKmsSigner. Dev/testnet: use an EnvSigner. */
  signer: Signer;
  policyEngine: PolicyEngine;
  enforceTimeBounds?: boolean;
  maxValidityWindowSeconds?: number;
  webhookDispatcher?: WebhookDispatcher;
  /** Optional real-time fraud/anomaly detector. */
  fraudDetector?: FraudDetector;
}

export interface CosignRequest {
  xdr: string;
  walletAddress: string;
  /** Originating IP address, used for geo-IP anomaly detection. */
  ipAddress?: string;
  /** Optional pre-resolved geo location for the request. */
  geo?: { country?: string; latitude?: number; longitude?: number };
}

export interface CosignResult {
  signedXdr: string;
  approved: boolean;
  reason?: string;
  code?: string;
}

export interface BatchCosignItemResult {
  index: number;
  signedXdr?: string;
  approved: boolean;
  reason?: string;
  code?: string;
}

export interface BatchCosignResult {
  approved: boolean;
  results: BatchCosignItemResult[];
}

export class CosignerService {
  private client: StellarClient;
  private signer: Signer;
  private policyEngine: PolicyEngine;
  private enforceTimeBounds: boolean;
  private maxValidityWindowSeconds?: number;
  private webhookDispatcher?: WebhookDispatcher;
  private fraudDetector?: FraudDetector;

  constructor(opts: CosignerOpts) {
    this.client = opts.client;
    this.signer = opts.signer;
    this.policyEngine = opts.policyEngine;
    this.enforceTimeBounds = opts.enforceTimeBounds ?? false;
    this.maxValidityWindowSeconds = opts.maxValidityWindowSeconds;
    this.webhookDispatcher = opts.webhookDispatcher;
    this.fraudDetector = opts.fraudDetector;
  }

  get publicKey(): string {
    return this.signer.publicKey();
  }

  async cosign(request: CosignRequest): Promise<CosignResult> {
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

    if (this.fraudDetector) {
      const fraudResult = await this.fraudDetector.score({
        walletAddress: request.walletAddress,
        transaction: tx,
        ipAddress: request.ipAddress,
        geo: request.geo,
      });

      if (fraudResult.rejected) {
        if (this.webhookDispatcher) {
          this.webhookDispatcher
            .dispatch("fraud.detected", {
              walletAddress: request.walletAddress,
              reason: fraudResult.reason,
              code: fraudResult.code,
              riskScore: fraudResult.riskScore,
              txHash: txHash.toString("hex"),
            })
            .catch(() => {});
        }

        return {
          signedXdr: "",
          approved: false,
          reason: fraudResult.reason,
          code: fraudResult.code,
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

  /**
   * Co-signs a batch of transactions. Each item is validated and evaluated
   * independently; the signing step is performed atomically after all
   * evaluations complete (all-or-nothing signing).
   */
  async cosignBatch(requests: CosignRequest[]): Promise<BatchCosignResult> {
    const results: BatchCosignItemResult[] = [];
    const signable: Array<{ index: number; tx: Transaction; txHash: Buffer }> =
      [];

    for (let index = 0; index < requests.length; index++) {
      const request = requests[index];
      const outcome = await this.evaluateForBatch(request);

      if (!outcome.approved) {
        results.push({
          index,
          approved: false,
          reason: outcome.reason,
          code: outcome.code,
        });
        continue;
      }

      results.push({ index, approved: true });
      signable.push({
        index,
        tx: outcome.tx,
        txHash: outcome.txHash,
      });
    }

    // Atomic signing step: only reached once every item has been evaluated.
    for (const item of signable) {
      try {
        const signature = await this.signer.sign(item.txHash);
        const rawPublicKey = Keypair.fromPublicKey(
          this.signer.publicKey()
        ).rawPublicKey();
        const hint = rawPublicKey.slice(-4);

        item.tx.signatures.push(
          new xdr.DecoratedSignature({
            hint,
            signature: Buffer.from(signature),
          })
        );

        const entry = results[item.index];
        entry.signedXdr = item.tx.toXDR();

        if (this.webhookDispatcher) {
          this.webhookDispatcher
            .dispatch("transaction.cosigned", {
              walletAddress: item.tx.source,
              txHash: item.txHash.toString("hex"),
            })
            .catch(() => {});
        }
      } catch (err) {
        const entry = results[item.index];
        entry.approved = false;
        entry.signedXdr = undefined;
        entry.reason =
          err instanceof Error ? err.message : "Signing failed for batch item";
      }
    }

    return {
      approved: results.every((r) => r.approved),
      results,
    };
  }

  private async evaluateForBatch(
    request: CosignRequest
  ): Promise<
    | { approved: true; tx: Transaction; txHash: Buffer }
    | { approved: false; reason?: string; code?: string }
  > {
    let parsed;
    try {
      parsed = TransactionBuilder.fromXDR(
        request.xdr,
        this.client.networkPassphrase
      );
    } catch {
      return { approved: false, reason: "Invalid transaction XDR" };
    }

    const tx = parsed instanceof Transaction ? parsed : null;
    if (!tx) {
      return {
        approved: false,
        reason:
          "Fee-bump transactions are not accepted for co-signing. Please submit a regular transaction.",
      };
    }

    if (tx.source !== request.walletAddress) {
      return {
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
          approved: false,
          reason: tbCheck.reason ?? "Timebounds validation failed",
        };
      }
    }

    if (this.fraudDetector) {
      const fraudResult = await this.fraudDetector.score({
        walletAddress: request.walletAddress,
        transaction: tx,
        ipAddress: request.ipAddress,
        geo: request.geo,
      });

      if (fraudResult.rejected) {
        if (this.webhookDispatcher) {
          this.webhookDispatcher
            .dispatch("fraud.detected", {
              walletAddress: request.walletAddress,
              reason: fraudResult.reason,
              code: fraudResult.code,
              riskScore: fraudResult.riskScore,
              txHash: txHash.toString("hex"),
            })
            .catch(() => {});
        }

        return {
          approved: false,
          reason: fraudResult.reason,
          code: fraudResult.code,
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

      return { approved: false, reason: policyResult.reason };
    }

    return { approved: true, tx, txHash };
  }
}
