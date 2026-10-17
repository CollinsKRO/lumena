/**
 * LumenTransactionFeed — #263
 *
 * Chronological activity feed of wallet transactions with asset icons,
 * relative timestamps, and explorer links. Status changes are animated:
 * pending transactions pulse and confirmed ones draw a checkmark.
 */

import React, { useEffect, useState } from "react";
import { useTransactionHistory, type Transaction } from "../use-transaction-history.js";

export type LumenTransactionStatus = "pending" | "confirmed" | "failed";

export interface LumenTransactionFeedProps {
  /** Wallet address whose transaction history is displayed. */
  walletId: string;
  /** Network used for explorer links. Defaults to "testnet". */
  network?: "testnet" | "public";
  /** Message shown when the history is empty. */
  emptyMessage?: string;
  /** Additional CSS class name(s) for the root element. */
  className?: string;
}

const ASSET_ICONS: Record<string, string> = {
  XLM: "✦",
  USDC: "$",
  EURC: "€",
};

const STATUS_COLORS: Record<LumenTransactionStatus, string> = {
  pending: "#ff9800",
  confirmed: "#4caf50",
  failed: "#f44336",
};

function getStatus(tx: Transaction): LumenTransactionStatus {
  if (tx.status === "pending" || tx.status === "confirmed" || tx.status === "failed") {
    return tx.status;
  }
  if (tx.successful === true) return "confirmed";
  if (tx.successful === false) return "failed";
  return "pending";
}

function getAssetCode(tx: Transaction): string {
  const code = tx.asset_code ?? tx.assetCode;
  return typeof code === "string" && code ? code : "XLM";
}

function getTimestamp(tx: Transaction): number | null {
  const value = tx.created_at ?? tx.createdAt;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function getTimeValue(tx: Transaction): number {
  return getTimestamp(tx) ?? Number.MAX_SAFE_INTEGER;
}

function formatRelativeTime(timestamp: number, now: number): string {
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function StatusIcon({ status }: { status: LumenTransactionStatus }): React.ReactElement {
  const color = STATUS_COLORS[status];

  if (status === "pending") {
    return (
      <span
        className="lumen-tx-feed__status lumen-tx-feed__status--pending"
        aria-label="Pending"
        style={{
          display: "inline-block",
          width: "0.75rem",
          height: "0.75rem",
          borderRadius: "50%",
          backgroundColor: color,
          animation: "lumen-tx-pulse 1.2s ease-in-out infinite",
        }}
      />
    );
  }

  if (status === "confirmed") {
    return (
      <svg
        className="lumen-tx-feed__status lumen-tx-feed__status--confirmed"
        aria-label="Confirmed"
        role="img"
        width="16"
        height="16"
        viewBox="0 0 16 16"
      >
        <path
          d="M3 8.5l3 3 7-7"
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: 16,
            strokeDashoffset: 0,
            animation: "lumen-tx-check 0.4s ease-out",
          }}
        />
      </svg>
    );
  }

  return (
    <span
      className="lumen-tx-feed__status lumen-tx-feed__status--failed"
      aria-label="Failed"
      style={{ color, fontWeight: 700, animation: "lumen-tx-fade-in 0.3s ease-out" }}
    >
      ✕
    </span>
  );
}

/**
 * Renders a wallet's transaction history as a chronological feed, newest first.
 */
export function LumenTransactionFeed({
  walletId,
  network = "testnet",
  emptyMessage = "No transactions yet",
  className,
}: LumenTransactionFeedProps): React.ReactElement {
  const { transactions, isLoading, error } = useTransactionHistory(walletId);
  const [now, setNow] = useState(() => Date.now());

  // Keep relative timestamps fresh.
  useEffect(() => {
    const intervalId = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(intervalId);
  }, []);

  const sorted = [...transactions].sort((a, b) => getTimeValue(b) - getTimeValue(a));

  const renderContent = () => {
    if (isLoading && transactions.length === 0) {
      return (
        <p className="lumen-tx-feed__loading" role="status" aria-busy="true">
          Loading transactions…
        </p>
      );
    }

    if (error) {
      return (
        <p className="lumen-tx-feed__error" role="alert" style={{ color: "#c0392b" }}>
          {error.message}
        </p>
      );
    }

    if (sorted.length === 0) {
      return (
        <p className="lumen-tx-feed__empty" style={{ color: "#666", textAlign: "center" }}>
          {emptyMessage}
        </p>
      );
    }

    return (
      <ul
        className="lumen-tx-feed__list"
        style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}
      >
        {sorted.map((tx) => {
          const status = getStatus(tx);
          const assetCode = getAssetCode(tx);
          const timestamp = getTimestamp(tx);
          const hash = typeof tx.hash === "string" ? tx.hash : tx.id;

          return (
            <li
              key={tx.id}
              className={`lumen-tx-feed__item lumen-tx-feed__item--${status}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                padding: "0.5rem 0.75rem",
                borderLeft: `3px solid ${STATUS_COLORS[status]}`,
                borderRadius: "4px",
                background: "#fafafa",
                transition: "border-color 0.3s ease",
                animation: "lumen-tx-fade-in 0.3s ease-out",
              }}
            >
              <span className="lumen-tx-feed__asset-icon" aria-label={assetCode} style={{ width: "1.5rem", textAlign: "center" }}>
                {ASSET_ICONS[assetCode] ?? assetCode.charAt(0)}
              </span>
              <span className="lumen-tx-feed__details" style={{ flex: 1, minWidth: 0 }}>
                <a
                  className="lumen-tx-feed__link"
                  href={`https://stellar.expert/explorer/${network}/tx/${hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontFamily: "monospace" }}
                >
                  {String(hash).slice(0, 12)}…
                </a>
                {timestamp !== null && (
                  <time
                    className="lumen-tx-feed__time"
                    dateTime={new Date(timestamp).toISOString()}
                    style={{ display: "block", fontSize: "0.8rem", color: "#666" }}
                  >
                    {formatRelativeTime(timestamp, now)}
                  </time>
                )}
              </span>
              {/* Keyed by status so the animation replays on every transition. */}
              <StatusIcon key={status} status={status} />
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className={["lumen-tx-feed", className].filter(Boolean).join(" ")}>
      <div className="lumen-tx-feed__live" aria-live="polite">
        {renderContent()}
      </div>
      <style>{`
        @keyframes lumen-tx-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.8); }
        }
        @keyframes lumen-tx-check {
          from { stroke-dashoffset: 16; }
          to { stroke-dashoffset: 0; }
        }
        @keyframes lumen-tx-fade-in {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
