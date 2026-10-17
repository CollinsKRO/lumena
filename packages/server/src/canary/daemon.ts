import { StellarClient } from '../stellar/client';
import { FeeSponsorService } from '../services/feeSponsor';
import { LumenLogger } from '../logger';

export interface CanaryDaemonOptions {
  client: StellarClient;
  feeSponsor: FeeSponsorService;
  cosignerPublicKey: string;
  intervalMs?: number;
  confirmationTimeoutMs?: number;
  amount?: string;
  destination?: string;
  logger?: LumenLogger;
}

export interface CanaryRunResult {
  success: boolean;
  latencyMs: number;
  timedOut: boolean;
  hash?: string;
  error?: string;
}

const DEFAULT_INTERVAL_MS = 300_000;
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60_000;
const DEFAULT_AMOUNT = '0.00001';
const MAX_CONSECUTIVE_FAILURES = 2;
const POLL_INTERVAL_MS = 1_000;

export class CanaryDaemon {
  private readonly client: StellarClient;
  private readonly feeSponsor: FeeSponsorService;
  private readonly cosignerPublicKey: string;
  private readonly intervalMs: number;
  private readonly confirmationTimeoutMs: number;
  private readonly amount: string;
  private readonly destination: string;
  private readonly logger?: LumenLogger;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private consecutiveFailures = 0;
  private alertCount = 0;
  private lastResult: CanaryRunResult | null = null;
  private readonly latencyHistogram: number[] = [];

  constructor(options: CanaryDaemonOptions) {
    this.client = options.client;
    this.feeSponsor = options.feeSponsor;
    this.cosignerPublicKey = options.cosignerPublicKey;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.confirmationTimeoutMs =
      options.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
    this.amount = options.amount ?? DEFAULT_AMOUNT;
    this.destination = options.destination ?? options.cosignerPublicKey;
    this.logger = options.logger;
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }

    this.logger?.info?.('Canary daemon starting', {
      intervalMs: this.intervalMs,
      confirmationTimeoutMs: this.confirmationTimeoutMs,
      amount: this.amount,
      destination: this.destination,
    });

    // Schedule an immediate run, then recurring runs.
    void this.runOnce().catch((err) => {
      this.logger?.error?.('Canary daemon immediate run failed unexpectedly', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.logger?.error?.('Canary daemon scheduled run failed unexpectedly', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.intervalMs);

    // Prevent the timer from keeping the process alive if nothing else is pending.
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger?.info?.('Canary daemon stopped');
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getAlertCount(): number {
    return this.alertCount;
  }

  getLastResult(): CanaryRunResult | null {
    return this.lastResult;
  }

  getLatencyHistogram(): number[] {
    return [...this.latencyHistogram];
  }

  async runOnce(): Promise<CanaryRunResult> {
    if (this.running) {
      this.logger?.warn?.('Canary run skipped: previous run still in progress');
      return (
        this.lastResult ?? {
          success: false,
          latencyMs: 0,
          timedOut: false,
          error: 'previous run still in progress',
        }
      );
    }

    this.running = true;
    const startedAt = Date.now();

    try {
      const result = await this.executeCanary(startedAt);
      this.lastResult = result;
      this.recordResult(result);
      return result;
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const result: CanaryRunResult = {
        success: false,
        latencyMs,
        timedOut: false,
        error: err instanceof Error ? err.message : String(err),
      };
      this.lastResult = result;
      this.recordResult(result);
      return result;
    } finally {
      this.running = false;
    }
  }

  private async executeCanary(startedAt: number): Promise<CanaryRunResult> {
    const submission = await this.feeSponsor.submit({
      sourceAccount: this.cosignerPublicKey,
      destination: this.destination,
      amount: this.amount,
      asset: 'XLM',
    });

    const hash = submission?.hash;
    if (!hash) {
      return {
        success: false,
        latencyMs: Date.now() - startedAt,
        timedOut: false,
        error: 'fee sponsor submission did not return a transaction hash',
      };
    }

    const confirmation = await this.pollForConfirmation(hash, startedAt);

    if (confirmation.timedOut) {
      return {
        success: false,
        latencyMs: Date.now() - startedAt,
        timedOut: true,
        hash,
        error: 'canary transaction confirmation timed out',
      };
    }

    if (!confirmation.confirmed) {
      return {
        success: false,
        latencyMs: Date.now() - startedAt,
        timedOut: false,
        hash,
        error: confirmation.error ?? 'canary transaction was not confirmed',
      };
    }

    return {
      success: true,
      latencyMs: Date.now() - startedAt,
      timedOut: false,
      hash,
    };
  }

  private async pollForConfirmation(
    hash: string,
    startedAt: number,
  ): Promise<{ confirmed: boolean; timedOut: boolean; error?: string }> {
    const deadline = startedAt + this.confirmationTimeoutMs;

    while (Date.now() < deadline) {
      try {
        const tx = await this.client.getTransaction(hash);

        if (tx) {
          const successful = (tx as { successful?: boolean }).successful;
          if (successful === true) {
            return { confirmed: true, timedOut: false };
          }
          if (successful === false) {
            return {
              confirmed: false,
              timedOut: false,
              error: 'canary transaction failed on-chain',
            };
          }
        }
      } catch (err) {
        // Transient errors (e.g. 404 while pending) are ignored; keep polling.
        this.logger?.debug?.('Canary confirmation poll error', {
          hash,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await this.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }

    return { confirmed: false, timedOut: true };
  }

  private recordResult(result: CanaryRunResult): void {
    this.latencyHistogram.push(result.latencyMs);

    if (result.success) {
      this.consecutiveFailures = 0;
      this.logger?.info?.('Canary transaction confirmed', {
        hash: result.hash,
        latencyMs: result.latencyMs,
      });
      return;
    }

    this.consecutiveFailures += 1;

    this.logger?.warn?.('Canary transaction failed', {
      hash: result.hash,
      latencyMs: result.latencyMs,
      timedOut: result.timedOut,
      consecutiveFailures: this.consecutiveFailures,
      error: result.error,
    });

    if (result.timedOut || this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.alertCount += 1;
      this.logger?.error?.('Canary alert: synthetic transaction health check failing', {
        hash: result.hash,
        latencyMs: result.latencyMs,
        timedOut: result.timedOut,
        consecutiveFailures: this.consecutiveFailures,
        alertCount: this.alertCount,
        error: result.error,
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}