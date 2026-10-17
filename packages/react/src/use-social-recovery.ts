/**
 * useSocialRecovery — #260
 *
 * Orchestrates multi-guardian account recovery.
 *
 * Flow:
 *  1. Owner calls `initiateRecovery(newPublicKey)` to open a recovery request.
 *  2. Guardians call `approveRecovery(recoveryId)` to add their signature.
 *  3. The hook polls the guardian signature count and the timelock deadline,
 *     reporting progression: initiated → guardian-approved → timelocked → executable.
 *  4. The owner may `cancelRecovery()` at any point before execution.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLumen } from "./context.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecoveryStatus =
  | "idle"
  | "initiating"
  | "initiated"
  | "guardian-approved"
  | "timelocked"
  | "executable"
  | "executed"
  | "cancelled"
  | "error";

export interface RecoveryRequest {
  /** Server-issued recovery identifier. */
  id: string;
  /** Wallet being recovered. */
  walletId: string;
  /** Public key that will replace the current owner key. */
  newPublicKey: string;
  /** Number of guardian signatures collected so far. */
  approvals: number;
  /** Number of guardian signatures required. */
  threshold: number;
  /** ISO-8601 timestamp at which the timelock ends, once the threshold is met. */
  timelockEndsAt: string | null;
  /** Set once the recovery has been executed or cancelled. */
  state?: "pending" | "executed" | "cancelled";
}

export interface UseSocialRecoveryOptions {
  /**
   * How often to poll the recovery request (milliseconds).
   * Defaults to 5 000.
   */
  pollInterval?: number;
}

export interface UseSocialRecoveryResult {
  /** Current stage of the recovery flow. */
  recoveryStatus: RecoveryStatus;
  /** Latest recovery request returned by the server. */
  recovery: RecoveryRequest | null;
  /** Guardian signatures collected so far. */
  approvals: number;
  /** Guardian signatures required. */
  threshold: number;
  /** Seconds remaining until the timelock ends (0 when not timelocked). */
  timelockRemainingSeconds: number;
  /** Most recent error, if any. */
  error: Error | null;
  /** Opens a recovery request rotating the wallet to `newPublicKey`. */
  initiateRecovery: (newPublicKey: string) => Promise<void>;
  /** Adds a guardian approval to the given recovery request. */
  approveRecovery: (recoveryId: string) => Promise<void>;
  /** Cancels the active recovery request. */
  cancelRecovery: () => Promise<void>;
}

const TERMINAL_STATUSES: RecoveryStatus[] = ["executable", "executed", "cancelled"];

/** Derives the recovery stage from the server state and the current time. */
export function deriveRecoveryStatus(recovery: RecoveryRequest, now: number): RecoveryStatus {
  if (recovery.state === "executed") return "executed";
  if (recovery.state === "cancelled") return "cancelled";
  if (recovery.approvals < recovery.threshold) return "initiated";
  if (!recovery.timelockEndsAt) return "guardian-approved";
  return Date.parse(recovery.timelockEndsAt) > now ? "timelocked" : "executable";
}

function remainingSeconds(recovery: RecoveryRequest | null, now: number): number {
  if (!recovery?.timelockEndsAt) return 0;
  return Math.max(0, Math.ceil((Date.parse(recovery.timelockEndsAt) - now) / 1000));
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function useSocialRecovery(
  walletId: string,
  options: UseSocialRecoveryOptions = {},
): UseSocialRecoveryResult {
  const { client } = useLumen();
  const { pollInterval = 5_000 } = options;

  const [recovery, setRecovery] = useState<RecoveryRequest | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus>("idle");
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<Error | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const fail = useCallback(
    (err: unknown) => {
      if (!mountedRef.current) return;
      stopPolling();
      setError(err instanceof Error ? err : new Error(String(err)));
      setRecoveryStatus("error");
    },
    [stopPolling],
  );

  /** Applies a server response and keeps polling until a terminal stage. */
  const track = useCallback(
    (data: RecoveryRequest) => {
      if (!mountedRef.current) return;

      const current = Date.now();
      const status = deriveRecoveryStatus(data, current);
      setRecovery(data);
      setNow(current);
      setRecoveryStatus(status);

      stopPolling();
      if (TERMINAL_STATUSES.includes(status)) return;

      pollTimerRef.current = setTimeout(() => {
        client
          .get<RecoveryRequest>(`/recovery/${encodeURIComponent(data.id)}`)
          .then(track)
          .catch(fail);
      }, pollInterval);
    },
    [client, pollInterval, stopPolling, fail],
  );

  const initiateRecovery = useCallback(
    async (newPublicKey: string): Promise<void> => {
      stopPolling();
      setRecoveryStatus("initiating");
      setRecovery(null);
      setError(null);

      try {
        const data = await client.get<RecoveryRequest>(
          `/recovery/initiate?walletId=${encodeURIComponent(walletId)}&newPublicKey=${encodeURIComponent(newPublicKey)}`,
        );
        track(data);
      } catch (err) {
        fail(err);
      }
    },
    [client, walletId, stopPolling, track, fail],
  );

  const approveRecovery = useCallback(
    async (recoveryId: string): Promise<void> => {
      setError(null);

      try {
        const data = await client.get<RecoveryRequest>(
          `/recovery/${encodeURIComponent(recoveryId)}/approve`,
        );
        track(data);
      } catch (err) {
        fail(err);
      }
    },
    [client, track, fail],
  );

  const cancelRecovery = useCallback(async (): Promise<void> => {
    if (!recovery) {
      throw new Error("No active recovery request to cancel");
    }

    stopPolling();
    setError(null);

    try {
      const data = await client.get<RecoveryRequest>(
        `/recovery/${encodeURIComponent(recovery.id)}/cancel`,
      );
      track(data);
    } catch (err) {
      fail(err);
    }
  }, [client, recovery, stopPolling, track, fail]);

  // Tick the timelock countdown once per second while timelocked.
  useEffect(() => {
    if (recoveryStatus !== "timelocked" || !recovery) return;

    const id = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (deriveRecoveryStatus(recovery, current) === "executable") {
        stopPolling();
        setRecoveryStatus("executable");
      }
    }, 1000);
    return () => clearInterval(id);
  }, [recoveryStatus, recovery, stopPolling]);

  return {
    recoveryStatus,
    recovery,
    approvals: recovery?.approvals ?? 0,
    threshold: recovery?.threshold ?? 0,
    timelockRemainingSeconds: remainingSeconds(recovery, now),
    error,
    initiateRecovery,
    approveRecovery,
    cancelRecovery,
  };
}
