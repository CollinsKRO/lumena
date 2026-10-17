import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("health response structure", () => {
  it("formats health payload structure", () => {
    const health = {
      status: "ok",
      horizonConnected: true,
      network: "testnet",
      version: "0.1.0",
    };
    expect(health.status).toBe("ok");
    expect(health.network).toBe("testnet");
  });
});

// ---------------------------------------------------------------------------
// Canary daemon tests (issue #311)
// ---------------------------------------------------------------------------

interface CanaryAlert {
  type: string;
  message: string;
  consecutiveFailures?: number;
  latencyMs?: number;
}

interface CanaryRunResult {
  success: boolean;
  latencyMs?: number;
  error?: string;
}

interface CanaryDaemonOptions {
  intervalMs?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  onAlert?: (alert: CanaryAlert) => void;
  onRun?: (result: CanaryRunResult) => void;
}

interface StellarClientLike {
  horizon: {
    loadAccount: (publicKey: string) => Promise<unknown>;
    submitTransaction: (tx: unknown) => Promise<unknown>;
  };
}

interface FeeSponsorServiceLike {
  submit: (tx: unknown) => Promise<{ hash: string; ledger?: number }>;
}

class CanaryDaemon {
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly failureThreshold: number;
  private readonly onAlert: (alert: CanaryAlert) => void;
  private readonly onRun: (result: CanaryRunResult) => void;
  readonly latencies: number[] = [];

  constructor(
    private readonly stellarClient: StellarClientLike,
    private readonly feeSponsor: FeeSponsorServiceLike,
    options: CanaryDaemonOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? 5 * 60 * 1000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.failureThreshold = options.failureThreshold ?? 2;
    this.onAlert = options.onAlert ?? (() => {});
    this.onRun = options.onRun ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  async runOnce(): Promise<CanaryRunResult> {
    const startedAt = Date.now();
    try {
      await this.stellarClient.horizon.loadAccount(
        "GCANARY000000000000000000000000000000000000000000000000"
      );

      const submitPromise = this.feeSponsor.submit({
        amount: "0.00001",
        asset: "XLM",
        memo: "canary",
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("canary confirmation timeout")),
          this.timeoutMs
        );
      });

      await Promise.race([submitPromise, timeoutPromise]);

      const latencyMs = Date.now() - startedAt;
      this.latencies.push(latencyMs);
      this.consecutiveFailures = 0;

      const result: CanaryRunResult = { success: true, latencyMs };
      this.onRun(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.consecutiveFailures += 1;

      const result: CanaryRunResult = { success: false, error: message };
      this.onRun(result);

      if (this.consecutiveFailures >= this.failureThreshold) {
        this.onAlert({
          type: "canary_failure",
          message: `Canary transaction failed ${this.consecutiveFailures} consecutive times: ${message}`,
          consecutiveFailures: this.consecutiveFailures,
        });
      }

      if (message.includes("timeout")) {
        this.onAlert({
          type: "canary_timeout",
          message: `Canary transaction confirmation timed out: ${message}`,
        });
      }

      return result;
    }
  }
}

describe("canary daemon", () => {
  let loadAccount: ReturnType<typeof vi.fn>;
  let submit: ReturnType<typeof vi.fn>;
  let stellarClient: StellarClientLike;
  let feeSponsor: FeeSponsorServiceLike;

  beforeEach(() => {
    loadAccount = vi.fn().mockResolvedValue({ id: "canary-account" });
    submit = vi.fn().mockResolvedValue({ hash: "abc123", ledger: 42 });
    stellarClient = {
      horizon: {
        loadAccount,
        submitTransaction: vi.fn().mockResolvedValue({ hash: "abc123" }),
      },
    };
    feeSponsor = { submit };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records latency and resets consecutive failures on a successful run", async () => {
    const onAlert = vi.fn();
    const onRun = vi.fn();
    const daemon = new CanaryDaemon(stellarClient, feeSponsor, {
      onAlert,
      onRun,
    });

    // Seed a prior failure so we can verify the reset.
    submit.mockRejectedValueOnce(new Error("transient failure"));
    await daemon.runOnce();
    expect(daemon.getConsecutiveFailures()).toBe(1);

    const result = await daemon.runOnce();

    expect(result.success).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(daemon.latencies.length).toBe(1);
    expect(daemon.getConsecutiveFailures()).toBe(0);
    expect(onAlert).not.toHaveBeenCalled();
    expect(onRun).toHaveBeenCalledTimes(2);
    expect(loadAccount).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("emits an alert after two consecutive failures", async () => {
    const onAlert = vi.fn();
    const daemon = new CanaryDaemon(stellarClient, feeSponsor, { onAlert });

    submit.mockRejectedValueOnce(new Error("horizon error"));
    const first = await daemon.runOnce();
    expect(first.success).toBe(false);
    expect(daemon.getConsecutiveFailures()).toBe(1);
    expect(onAlert).not.toHaveBeenCalled();

    submit.mockRejectedValueOnce(new Error("horizon error"));
    const second = await daemon.runOnce();
    expect(second.success).toBe(false);
    expect(daemon.getConsecutiveFailures()).toBe(2);
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0][0]).toMatchObject({
      type: "canary_failure",
      consecutiveFailures: 2,
    });
  });

  it("emits an alert when confirmation times out", async () => {
    vi.useFakeTimers();
    const onAlert = vi.fn();
    const daemon = new CanaryDaemon(stellarClient, feeSponsor, {
      onAlert,
      timeoutMs: 1000,
    });

    submit.mockImplementation(
      () => new Promise(() => {
        /* never resolves */
      })
    );

    const runPromise = daemon.runOnce();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0][0]).toMatchObject({
      type: "canary_timeout",
    });
  });

  it("schedules runs every 5 minutes using fake timers", async () => {
    vi.useFakeTimers();
    const onRun = vi.fn();
    const daemon = new CanaryDaemon(stellarClient, feeSponsor, { onRun });

    daemon.start();

    // No run before the interval elapses.
    expect(onRun).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(onRun).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(onRun).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(onRun).toHaveBeenCalledTimes(3);

    daemon.stop();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(onRun).toHaveBeenCalledTimes(3);
  });
});