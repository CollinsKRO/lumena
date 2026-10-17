'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionKey } from './use-session-key';

/**
 * Represents an active session key managed by the hook.
 */
export interface ActiveSessionKey {
  /** The public key / address of the session key signer. */
  publicKey: string;
  /** Unix timestamp (ms) at which the session key expires. */
  expiresAt: number;
  /** Total spending limit (in stroops or the wallet's base unit) for this key. */
  limit: bigint;
  /** Amount already spent by this key. */
  spent: bigint;
  /** Remaining spending quota (limit - spent, floored at 0). */
  remaining: bigint;
  /** Remaining time-to-live in seconds (floored at 0). */
  ttlSeconds: number;
}

/**
 * Options for {@link useSessionKeyManager}.
 */
export interface UseSessionKeyManagerOptions {
  /**
   * Optional Lumen client used to build, co-sign, and submit transactions.
   * When omitted, the hook falls back to the client provided via context
   * by `useSessionKey`.
   */
  client?: LumenClientLike;
  /**
   * Interval (ms) at which the TTL countdown ticks. Defaults to 1000ms.
   */
  tickIntervalMs?: number;
  /**
   * Called after a session key has been successfully revoked.
   */
  onRevoked?: (sessionKeyAddress: string) => void;
  /**
   * Called when a revocation fails.
   */
  onRevokeError?: (sessionKeyAddress: string, error: unknown) => void;
}

/**
 * Minimal shape of the Lumen client required by this hook.
 * Kept structural so the hook does not hard-depend on a concrete class.
 */
export interface LumenClientLike {
  buildSetOptionsTransaction?: (params: {
    walletId: string;
    signerToRemove: string;
  }) => Promise<unknown>;
  buildRemoveDelegationTransaction?: (params: {
    walletId: string;
    sessionKey: string;
  }) => Promise<unknown>;
  coSign?: (transaction: unknown) => Promise<unknown>;
  submit?: (transaction: unknown) => Promise<unknown>;
}

/**
 * Result returned by {@link useSessionKeyManager}.
 */
export interface UseSessionKeyManagerResult {
  /** Active session keys with public key, expiration, and quota info. */
  sessionKeys: ActiveSessionKey[];
  /** Whether the underlying session key data is still loading. */
  isLoading: boolean;
  /** Error encountered while loading session key data, if any. */
  error: Error | null;
  /** Whether a revocation is currently in flight. */
  isRevoking: boolean;
  /** Error from the most recent revocation attempt, if any. */
  revokeError: Error | null;
  /**
   * Revoke a session key by removing its multisig signer (or on-chain
   * delegation) via a co-signed `setOptions` transaction.
   */
  revoke: (sessionKeyAddress: string) => Promise<void>;
  /** Manually refresh the session key state. */
  refresh: () => Promise<void>;
}

const DEFAULT_TICK_INTERVAL_MS = 1000;

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeExpiresAt(value: unknown): number {
  const numeric = toNumber(value);
  if (numeric <= 0) return 0;
  // Heuristic: values below ~year 2286 in seconds are treated as seconds.
  if (numeric < 1e12) return numeric * 1000;
  return numeric;
}

interface RawSessionKey {
  publicKey?: string;
  address?: string;
  signer?: string;
  expiresAt?: number | string | bigint;
  expiration?: number | string | bigint;
  limit?: number | string | bigint;
  spendingLimit?: number | string | bigint;
  spent?: number | string | bigint;
  spentAmount?: number | string | bigint;
}

function normalizeSessionKey(raw: RawSessionKey): {
  publicKey: string;
  expiresAt: number;
  limit: bigint;
  spent: bigint;
} {
  const publicKey =
    raw.publicKey ?? raw.address ?? raw.signer ?? '';
  const expiresAt = normalizeExpiresAt(raw.expiresAt ?? raw.expiration);
  const limit = toBigInt(raw.limit ?? raw.spendingLimit);
  const spent = toBigInt(raw.spent ?? raw.spentAmount);
  return { publicKey, expiresAt, limit, spent };
}

function computeTtlSeconds(expiresAt: number, now: number): number {
  if (expiresAt <= 0) return 0;
  const diffMs = expiresAt - now;
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / 1000);
}

function computeRemaining(limit: bigint, spent: bigint): bigint {
  const remaining = limit - spent;
  return remaining > 0n ? remaining : 0n;
}

/**
 * Hook for managing temporary session keys: exposes active keys, a per-second
 * TTL countdown, remaining spending quota, and instant revocation.
 *
 * @param walletId - The wallet whose session keys are being managed.
 * @param options  - Optional configuration (client, tick interval, callbacks).
 */
export function useSessionKeyManager(
  walletId: string,
  options: UseSessionKeyManagerOptions = {},
): UseSessionKeyManagerResult {
  const {
    client,
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    onRevoked,
    onRevokeError,
  } = options;

  const sessionKey = useSessionKey(walletId);

  const [now, setNow] = useState<number>(() => Date.now());
  const [isRevoking, setIsRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<Error | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Per-second countdown tick, cleaned up on unmount.
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, tickIntervalMs);
    return () => {
      clearInterval(interval);
    };
  }, [tickIntervalMs]);

  const rawKeys = useMemo<RawSessionKey[]>(() => {
    const source =
      (sessionKey as { sessionKeys?: unknown; keys?: unknown }).sessionKeys ??
      (sessionKey as { keys?: unknown }).keys;
    if (Array.isArray(source)) {
      return source as RawSessionKey[];
    }
    const single =
      (sessionKey as { sessionKey?: unknown }).sessionKey;
    if (single && typeof single === 'object') {
      return [single as RawSessionKey];
    }
    return [];
  }, [sessionKey]);

  const sessionKeys = useMemo<ActiveSessionKey[]>(() => {
    return rawKeys
      .map((raw) => {
        const normalized = normalizeSessionKey(raw);
        return {
          publicKey: normalized.publicKey,
          expiresAt: normalized.expiresAt,
          limit: normalized.limit,
          spent: normalized.spent,
          remaining: computeRemaining(normalized.limit, normalized.spent),
          ttlSeconds: computeTtlSeconds(normalized.expiresAt, now),
        };
      })
      .filter((key) => key.publicKey !== '');
  }, [rawKeys, now]);

  const isLoading = Boolean(
    (sessionKey as { isLoading?: boolean }).isLoading,
  );

  const error = useMemo<Error | null>(() => {
    const rawError = (sessionKey as { error?: unknown }).error;
    if (!rawError) return null;
    if (rawError instanceof Error) return rawError;
    return new Error(String(rawError));
  }, [sessionKey]);

  const refresh = useCallback(async () => {
    const refreshFn = (sessionKey as { refresh?: () => unknown }).refresh;
    if (typeof refreshFn === 'function') {
      await refreshFn();
    }
  }, [sessionKey]);

  const revoke = useCallback(
    async (sessionKeyAddress: string) => {
      if (!sessionKeyAddress) {
        throw new Error('sessionKeyAddress is required to revoke a session key');
      }

      const activeClient =
        client ??
        ((sessionKey as { client?: LumenClientLike }).client ?? undefined);

      if (!activeClient) {
        throw new Error(
          'No Lumen client available to revoke the session key',
        );
      }

      setIsRevoking(true);
      setRevokeError(null);

      try {
        let transaction: unknown;

        if (typeof activeClient.buildSetOptionsTransaction === 'function') {
          transaction = await activeClient.buildSetOptionsTransaction({
            walletId,
            signerToRemove: sessionKeyAddress,
          });
        } else if (
          typeof activeClient.buildRemoveDelegationTransaction === 'function'
        ) {
          transaction = await activeClient.buildRemoveDelegationTransaction({
            walletId,
            sessionKey: sessionKeyAddress,
          });
        } else {
          throw new Error(
            'Lumen client does not support session key revocation',
          );
        }

        let signedTransaction = transaction;
        if (typeof activeClient.coSign === 'function') {
          signedTransaction = await activeClient.coSign(transaction);
        }

        if (typeof activeClient.submit === 'function') {
          await activeClient.submit(signedTransaction);
        }

        await refresh();

        if (mountedRef.current) {
          onRevoked?.(sessionKeyAddress);
        }
      } catch (err) {
        const normalizedError =
          err instanceof Error ? err : new Error(String(err));
        if (mountedRef.current) {
          setRevokeError(normalizedError);
          onRevokeError?.(sessionKeyAddress, normalizedError);
        }
        throw normalizedError;
      } finally {
        if (mountedRef.current) {
          setIsRevoking(false);
        }
      }
    },
    [client, sessionKey, walletId, refresh, onRevoked, onRevokeError],
  );

  return {
    sessionKeys,
    isLoading,
    error,
    isRevoking,
    revokeError,
    revoke,
    refresh,
  };
}

export default useSessionKeyManager;