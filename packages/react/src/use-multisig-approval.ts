/**
 * useMultiSigApproval — #279
 *
 * Orchestrates multi-device co-signing sessions for high-value transactions.
 *
 * Flow:
 *  1. Caller invokes `createSession(xdr, walletId)` with the unsigned XDR envelope.
 *  2. Hook posts to POST /multisig/session and receives a session ID + approval URL.
 *  3. A QR code link is derived from the approval URL so the secondary device can
 *     open it directly.
 *  4. Hook polls GET /multisig/session/:id at a configurable interval until the
 *     remote device signs or the session times out.
 *  5. Once status === "approved", the hook calls POST /multisig/session/:id/merge
 *     which returns the final co-signed XDR combining both device signatures.
 *  6. Caller receives the merged XDR via `onMerged` callback or the `mergedXdr` field.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLumen } from "./context.js";
import { useTranslation } from "./i18n/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MultiSigSessionStatus =
  | "idle"
  | "creating"
  | "pending"
  | "approved"
  | "merging"
  | "merged"
  | "rejected"
  | "expired"
  | "error";

export interface MultiSigSession {
  /** Server-issued session identifier. */
  id: string;
  /** URL the secondary device must open to approve (can be rendered as QR). */
  approvalUrl: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
}

export interface UseMultiSigApprovalOptions {
  /**
   * How often to poll the session status (milliseconds).
   * Defaults to 2 000.
   */
  pollInterval?: number;
  /**
   * Called when both signatures are successfully merged into a final XDR.
   */
  onMerged?: (mergedXdr: string) => void;
  /**
   * Called when the session is rejected or expires.
   */
  onFailed?: (reason: string) => void;
}

// ---------------------------------------------------------------------------
// Proxy upgrade types (#224)
// ---------------------------------------------------------------------------

export type ProxyUpgradeStatus =
  | "idle"
  | "proposing"
  | "proposed"
  | "approving"
  | "approved"
  | "executing"
  | "executed"
  | "cancelled"
  | "error";

export interface ProxyUpgradeProposal {
  /** Server-issued proposal identifier. */
  id: string;
  /** Address of the proxy contract being upgraded. */
  proxyAddress: string;
  /** Hex-encoded hash of the new contract WASM. */
  wasmHash: string;
  /** Number of approvals collected so far. */
  approvals: number;
  /** Number of approvals required before execution is allowed. */
  threshold: number;
  /** ISO-8601 timestamp of when the timelock expires and execution is allowed. */
  timelockEndsAt: string;
  /** Whether the timelock has elapsed and the proposal can be executed. */
  executable: boolean;
}

export interface UseProxyUpgradeOptions {
  /**
   * How often to poll the proposal status (milliseconds).
   * Defaults to 5 000.
   */
  pollInterval?: number;
  /**
   * Called when the upgrade has been executed on-chain.
   */
  onExecuted?: (proposal: ProxyUpgradeProposal) => void;
  /**
   * Called when the proposal is cancelled or fails.
   */
  onFailed?: (reason: string) => void;
}

export interface UseMultiSigApprovalResult {
  /** Current status of the co-signing session. */
  status: MultiSigSessionStatus;
  /** Active session details (id, approvalUrl, expiresAt). Available after `createSession`. */
  session: MultiSigSession | null;
  /**
   * Convenience data-URI string for rendering a QR code.
   * Contains the `approvalUrl` encoded as a `web+lumen:cosign?url=` URI so
   * any QR library can render it without additional transformation.
   */
  qrValue: string | null;
  /** Final merged co-signed XDR. Available once status === "merged". */
  mergedXdr: string | null;
  /** Most recent error, if any. */
  error: Error | null;
  /**
   * Initiates a new co-signing session.
   * @param xdr      The base-64 XDR of the transaction to be co-signed.
   * @param walletId The Stellar wallet address initiating the request.
   */
  createSession: (xdr: string, walletId: string) => Promise<void>;
  /** Cancels an active session and resets all state. */
  cancel: () => void;
  /** Resets state back to idle without cancelling a remote session. */
  reset: () => void;
}

export interface UseProxyUpgradeResult {
  /** Current status of the proxy upgrade proposal. */
  status: ProxyUpgradeStatus;
  /** Active proposal details. Available after `proposeUpgrade`. */
  proposal: ProxyUpgradeProposal | null;
  /** Whether the timelock has elapsed and the proposal can be executed. */
  executable: boolean;
  /** Most recent error, if any. */
  error: Error | null;
  /**
   * Proposes a new WASM hash for the given proxy contract.
   * @param proxyAddress The proxy contract address to upgrade.
   * @param wasmHash     Hex-encoded hash of the new contract WASM.
   */
  proposeUpgrade: (proxyAddress: string, wasmHash: string) => Promise<void>;
  /** Records an approval from the current signer for the active proposal. */
  approveUpgrade: () => Promise<void>;
  /** Executes the upgrade once the threshold and timelock are satisfied. */
  executeUpgrade: () => Promise<void>;
  /** Cancels the active proposal and resets all state. */
  cancelUpgrade: () => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function useMultiSigApproval(
  options: UseMultiSigApprovalOptions = {}
): UseMultiSigApprovalResult {
  const { client } = useLumen();
  const { t } = useTranslation();
  const { pollInterval = 2_000, onMerged, onFailed } = options;

  const [status, setStatus] = useState<MultiSigSessionStatus>("idle");
  const [session, setSession] = useState<MultiSigSession | null>(null);
  const [mergedXdr, setMergedXdr] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Keep a ref to the polling timer so we can clear it on unmount / cancel.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref to track whether the component is still mounted.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  /** Poll the session status until it reaches a terminal state. */
  const pollStatus = useCallback(
    (sessionId: string) => {
      const tick = async () => {
        if (!mountedRef.current) return;

        try {
          const data = await client.get<{
            status: "pending" | "approved" | "rejected" | "expired";
          }>(`/multisig/session/${sessionId}`);

          if (!mountedRef.current) return;

          if (data.status === "approved") {
            stopPolling();
            setStatus("merging");

            try {
              const mergeData = await client.get<{ mergedXdr: string }>(
                `/multisig/session/${sessionId}/merge`
              );

              if (!mountedRef.current) return;

              setMergedXdr(mergeData.mergedXdr);
              setStatus("merged");
              onMerged?.(mergeData.mergedXdr);
            } catch (mergeErr: unknown) {
              if (!mountedRef.current) return;
              const e =
                mergeErr instanceof Error
                  ? mergeErr
                  : new Error(t.multiSig.sessionError);
              setError(e);
              setStatus("error");
              onFailed?.(e.message);
            }
            return;
          }

          if (data.status === "rejected") {
            stopPolling();
            setStatus("rejected");
            onFailed?.(t.multiSig.sessionRejected);
            return;
          }

          if (data.status === "expired") {
            stopPolling();
            setStatus("expired");
            onFailed?.(t.multiSig.sessionExpired);
            return;
          }

          // Still pending — schedule the next tick.
          pollTimerRef.current = setTimeout(() => {
            void tick();
          }, pollInterval);
        } catch (pollErr: unknown) {
          if (!mountedRef.current) return;
          stopPolling();
          const e =
            pollErr instanceof Error
              ? pollErr
              : new Error(t.errors.network);
          setError(e);
          setStatus("error");
          onFailed?.(e.message);
        }
      };

      pollTimerRef.current = setTimeout(() => {
        void tick();
      }, pollInterval);
    },
    [client, pollInterval, stopPolling, onMerged, onFailed, t]
  );

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const createSession = useCallback(
    async (xdr: string, walletId: string): Promise<void> => {
      stopPolling();
      setStatus("creating");
      setSession(null);
      setMergedXdr(null);
      setError(null);

      try {
        const data = await client.get<MultiSigSession>(
          `/multisig/session?xdr=${encodeURIComponent(xdr)}&walletId=${encodeURIComponent(walletId)}`
        );

        if (!mountedRef.current) return;

        setSession(data);
        setStatus("pending");
        pollStatus(data.id);
      } catch (createErr: unknown) {
        if (!mountedRef.current) return;
        const e =
          createErr instanceof Error
            ? createErr
            : new Error(t.multiSig.sessionError);
        setError(e);
        setStatus("error");
        onFailed?.(e.message);
      }
    },
    [client, stopPolling, pollStatus, onFailed, t]
  );

  const cancel = useCallback(() => {
    stopPolling();
    setStatus("idle");
    setSession(null);
    setMergedXdr(null);
    setError(null);
  }, [stopPolling]);

  const reset = useCallback(() => {
    setStatus("idle");
    setSession(null);
    setMergedXdr(null);
    setError(null);
  }, []);

  // Derive a QR-friendly value from the session's approval URL.
  const qrValue = session
    ? `web+lumen:cosign?url=${encodeURIComponent(session.approvalUrl)}`
    : null;

  return {
    status,
    session,
    qrValue,
    mergedXdr,
    error,
    createSession,
    cancel,
    reset,
  };
}

// ---------------------------------------------------------------------------
// Proxy upgrade hook (#224)
// ---------------------------------------------------------------------------

export function useProxyUpgrade(
  options: UseProxyUpgradeOptions = {}
): UseProxyUpgradeResult {
  const { client } = useLumen();
  const { t } = useTranslation();
  const { pollInterval = 5_000, onExecuted, onFailed } = options;

  const [status, setStatus] = useState<ProxyUpgradeStatus>("idle");
  const [proposal, setProposal] = useState<ProxyUpgradeProposal | null>(null);
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

  /** Poll the proposal until it is executed, cancelled, or fails. */
  const pollProposal = useCallback(
    (proposalId: string) => {
      const tick = async () => {
        if (!mountedRef.current) return;

        try {
          const data = await client.get<ProxyUpgradeProposal>(
            `/proxy/upgrade/${proposalId}`
          );

          if (!mountedRef.current) return;

          setProposal(data);

          if (data.executable && status === "approved") {
            setStatus("approved");
          }

          pollTimerRef.current = setTimeout(() => {
            void tick();
          }, pollInterval);
        } catch (pollErr: unknown) {
          if (!mountedRef.current) return;
          stopPolling();
          const e =
            pollErr instanceof Error ? pollErr : new Error(t.errors.network);
          setError(e);
          setStatus("error");
          onFailed?.(e.message);
        }
      };

      pollTimerRef.current = setTimeout(() => {
        void tick();
      }, pollInterval);
    },
    [client, pollInterval, stopPolling, onFailed, status, t]
  );

  const proposeUpgrade = useCallback(
    async (proxyAddress: string, wasmHash: string): Promise<void> => {
      stopPolling();
      setStatus("proposing");
      setProposal(null);
      setError(null);

      try {
        const data = await client.post<ProxyUpgradeProposal>(
          "/proxy/upgrade",
          { proxyAddress, wasmHash }
        );

        if (!mountedRef.current) return;

        setProposal(data);
        setStatus("proposed");
        pollProposal(data.id);
      } catch (proposeErr: unknown) {
        if (!mountedRef.current) return;
        const e =
          proposeErr instanceof Error
            ? proposeErr
            : new Error(t.errors.network);
        setError(e);
        setStatus("error");
        onFailed?.(e.message);
      }
    },
    [client, stopPolling, pollProposal, onFailed, t]
  );

  const approveUpgrade = useCallback(async (): Promise<void> => {
    if (!proposal) return;
    setStatus("approving");
    setError(null);

    try {
      const data = await client.post<ProxyUpgradeProposal>(
        `/proxy/upgrade/${proposal.id}/approve`,
        {}
      );

      if (!mountedRef.current) return;

      setProposal(data);
      setStatus("approved");
    } catch (approveErr: unknown) {
      if (!mountedRef.current) return;
      const e =
        approveErr instanceof Error ? approveErr : new Error(t.errors.network);
      setError(e);
      setStatus("error");
      onFailed?.(e.message);
    }
  }, [client, proposal, onFailed, t]);

  const executeUpgrade = useCallback(async (): Promise<void> => {
    if (!proposal) return;
    setStatus("executing");
    setError(null);

    try {
      const data = await client.post<ProxyUpgradeProposal>(
        `/proxy/upgrade/${proposal.id}/execute`,
        {}
      );

      if (!mountedRef.current) return;

      stopPolling();
      setProposal(data);
      setStatus("executed");
      onExecuted?.(data);
    } catch (executeErr: unknown) {
      if (!mountedRef.current) return;
      const e =
        executeErr instanceof Error
          ? executeErr
          : new Error(t.errors.network);
      setError(e);
      setStatus("error");
      onFailed?.(e.message);
    }
  }, [client, proposal, stopPolling, onExecuted, onFailed, t]);

  const cancelUpgrade = useCallback(() => {
    stopPolling();
    setStatus("cancelled");
    setProposal(null);
    setError(null);
  }, [stopPolling]);

  const executable = proposal?.executable ?? false;

  return {
    status,
    proposal,
    executable,
    error,
    proposeUpgrade,
    approveUpgrade,
    executeUpgrade,
    cancelUpgrade,
  };
}
