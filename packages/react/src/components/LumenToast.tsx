/**
 * LumenToast — Toast Notification Dispatcher
 *
 * Lightweight toast notification manager for transaction lifecycle events.
 * Supports automatic dismissal, status badges, and actionable buttons.
 *
 * Transaction lifecycle events:
 * - signing: Transaction is being signed by the user
 * - cosigning: Multi-device co-signing in progress
 * - fee_bumping: Fee bump operation in progress
 * - confirmed: Transaction confirmed on the network
 * - failed: Transaction failed
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToastStatus = "info" | "success" | "warning" | "error" | "loading";

export type TransactionLifecycleEvent =
  | "signing"
  | "cosigning"
  | "fee_bumping"
  | "confirmed"
  | "failed";

export interface ToastAction {
  /** Button label */
  label: string;
  /** Click handler */
  onClick: () => void;
  /** Optional button variant */
  variant?: "primary" | "secondary";
}

export interface Toast {
  /** Unique identifier for the toast */
  id: string;
  /** Toast message */
  message: string;
  /** Status type for styling */
  status: ToastStatus;
  /** Optional transaction lifecycle event for badge */
  lifecycleEvent?: TransactionLifecycleEvent;
  /** Optional actionable buttons */
  actions?: ToastAction[];
  /** Auto-dismiss duration in milliseconds. Set to 0 to disable. Defaults to 5000. */
  duration?: number;
  /** Timestamp when the toast was created */
  createdAt: number;
}

export interface ToastContextValue {
  /** Current toasts */
  toasts: Toast[];
  /** Add a new toast */
  addToast: (toast: Omit<Toast, "id" | "createdAt">) => string;
  /** Remove a toast by ID */
  removeToast: (id: string) => void;
  /** Clear all toasts */
  clearToasts: () => void;
  /** Dispatch a transaction lifecycle notification */
  dispatchTransactionEvent: (
    event: TransactionLifecycleEvent,
    message: string,
    options?: {
      transactionHash?: string;
      actions?: ToastAction[];
      duration?: number;
    }
  ) => string;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface LumenToastProviderProps {
  children: React.ReactNode;
  /** Maximum number of toasts to display at once. Defaults to 5. */
  maxToasts?: number;
  /** Default auto-dismiss duration in milliseconds. Defaults to 5000. */
  defaultDuration?: number;
  /** Position of the toast container. Defaults to "top-right". */
  position?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
}

export function LumenToastProvider({
  children,
  maxToasts = 5,
  defaultDuration = 5000,
  position = "top-right",
}: LumenToastProviderProps): React.ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const addToast = useCallback(
    (toast: Omit<Toast, "id" | "createdAt">): string => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const newToast: Toast = {
        ...toast,
        id,
        createdAt: Date.now(),
        duration: toast.duration ?? defaultDuration,
      };

      setToasts((prev) => {
        const filtered = prev.slice(-maxToasts + 1);
        return [...filtered, newToast];
      });

      // Auto-dismiss if duration > 0
      if (newToast.duration && newToast.duration > 0) {
        const timer = setTimeout(() => {
          removeToast(id);
        }, newToast.duration);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [defaultDuration, maxToasts, removeToast]
  );

  const clearToasts = useCallback(() => {
    setToasts([]);
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
  }, []);

  const dispatchTransactionEvent = useCallback(
    (
      event: TransactionLifecycleEvent,
      message: string,
      options?: {
        transactionHash?: string;
        actions?: ToastAction[];
        duration?: number;
      }
    ): string => {
      const status: ToastStatus = {
        signing: "loading",
        cosigning: "loading",
        fee_bumping: "loading",
        confirmed: "success",
        failed: "error",
      }[event];

      const actions = options?.actions ?? [];
      
      // Add "View on Stellar Expert" action if transaction hash is provided
      if (options?.transactionHash && event === "confirmed") {
        actions.push({
          label: "View on Stellar Expert",
          onClick: () => {
            window.open(`https://stellar.expert/explorer/testnet/tx/${options.transactionHash}`, "_blank");
          },
          variant: "secondary",
        });
      }

      return addToast({
        message,
        status,
        lifecycleEvent: event,
        actions,
        duration: options?.duration,
      });
    },
    [addToast]
  );

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
    };
  }, []);

  const contextValue: ToastContextValue = {
    toasts,
    addToast,
    removeToast,
    clearToasts,
    dispatchTransactionEvent,
  };

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <LumenToastContainer toasts={toasts} onRemove={removeToast} position={position} />
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a LumenToastProvider");
  }
  return context;
}

// ---------------------------------------------------------------------------
// Container Component
// ---------------------------------------------------------------------------

interface LumenToastContainerProps {
  toasts: Toast[];
  onRemove: (id: string) => void;
  position: "top-right" | "top-left" | "bottom-right" | "bottom-left";
}

function LumenToastContainer({
  toasts,
  onRemove,
  position,
}: LumenToastContainerProps): React.ReactElement | null {
  if (toasts.length === 0) return null;

  const positionStyles: Record<
    typeof position,
    React.CSSProperties
  > = {
    "top-right": {
      top: "1rem",
      right: "1rem",
    },
    "top-left": {
      top: "1rem",
      left: "1rem",
    },
    "bottom-right": {
      bottom: "1rem",
      right: "1rem",
    },
    "bottom-left": {
      bottom: "1rem",
      left: "1rem",
    },
  };

  return (
    <div
      className="lumen-toast-container"
      style={{
        position: "fixed",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        maxWidth: "400px",
        width: "100%",
        ...positionStyles[position],
      }}
      role="region"
      aria-label="Toast notifications"
    >
      {toasts.map((toast) => (
        <LumenToastItem key={toast.id} toast={toast} onRemove={onRemove} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toast Item Component
// ---------------------------------------------------------------------------

interface LumenToastItemProps {
  toast: Toast;
  onRemove: (id: string) => void;
}

function LumenToastItem({ toast, onRemove }: LumenToastItemProps): React.ReactElement {
  const statusColors: Record<ToastStatus, { bg: string; border: string; icon: string }> = {
    info: {
      bg: "#e3f2fd",
      border: "#2196f3",
      icon: "ℹ️",
    },
    success: {
      bg: "#e8f5e9",
      border: "#4caf50",
      icon: "✓",
    },
    warning: {
      bg: "#fff3e0",
      border: "#ff9800",
      icon: "⚠️",
    },
    error: {
      bg: "#ffebee",
      border: "#f44336",
      icon: "✕",
    },
    loading: {
      bg: "#f5f5f5",
      border: "#9e9e9e",
      icon: "⟳",
    },
  };

  const lifecycleBadgeColors: Record<TransactionLifecycleEvent, string> = {
    signing: "#2196f3",
    cosigning: "#9c27b0",
    fee_bumping: "#ff9800",
    confirmed: "#4caf50",
    failed: "#f44336",
  };

  const colors = statusColors[toast.status];

  return (
    <div
      className="lumen-toast"
      style={{
        backgroundColor: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: "8px",
        padding: "1rem",
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        animation: "lumen-toast-slide-in 0.3s ease-out",
      }}
      role="alert"
      aria-live="polite"
    >
      {/* Header with icon and close button */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span
            style={{
              fontSize: "1.25rem",
              lineHeight: 1,
            }}
            aria-hidden="true"
          >
            {toast.status === "loading" ? (
              <span
                style={{
                  display: "inline-block",
                  animation: "lumen-spin 1s linear infinite",
                }}
              >
                {colors.icon}
              </span>
            ) : (
              colors.icon
            )}
          </span>
          {toast.lifecycleEvent && (
            <span
              className="lumen-toast__badge"
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                textTransform: "uppercase",
                padding: "0.125rem 0.5rem",
                borderRadius: "9999px",
                backgroundColor: lifecycleBadgeColors[toast.lifecycleEvent],
                color: "white",
              }}
            >
              {toast.lifecycleEvent.replace("_", " ")}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onRemove(toast.id)}
          aria-label="Close notification"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: "1.25rem",
            lineHeight: 1,
            padding: "0.25rem",
            color: "inherit",
            opacity: 0.6,
            transition: "opacity 0.2s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = "1";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = "0.6";
          }}
        >
          ✕
        </button>
      </div>

      {/* Message */}
      <div
        style={{
          fontSize: "0.9rem",
          lineHeight: 1.4,
          color: "#333",
        }}
      >
        {toast.message}
      </div>

      {/* Actions */}
      {toast.actions && toast.actions.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            marginTop: "0.25rem",
            flexWrap: "wrap",
          }}
        >
          {toast.actions.map((action, index) => (
            <button
              key={index}
              type="button"
              onClick={action.onClick}
              style={{
                fontSize: "0.85rem",
                fontWeight: 500,
                padding: "0.375rem 0.75rem",
                borderRadius: "4px",
                border: action.variant === "primary" ? "none" : "1px solid #ccc",
                backgroundColor: action.variant === "primary" ? colors.border : "white",
                color: action.variant === "primary" ? "white" : "#333",
                cursor: "pointer",
                transition: "opacity 0.2s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "0.8";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "1";
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {/* Inline styles for animations */}
      <style>{`
        @keyframes lumen-toast-slide-in {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes lumen-spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Convenience Component (for direct usage without provider)
// ---------------------------------------------------------------------------

export interface LumenToastProps {
  /** Toast message */
  message: string;
  /** Status type */
  status?: ToastStatus;
  /** Optional transaction lifecycle event */
  lifecycleEvent?: TransactionLifecycleEvent;
  /** Optional actionable buttons */
  actions?: ToastAction[];
  /** Auto-dismiss duration in milliseconds. Set to 0 to disable. */
  duration?: number;
  /** Callback when toast is dismissed */
  onDismiss?: () => void;
}

/**
 * Standalone toast component for simple use cases.
 * For advanced usage with multiple toasts, use LumenToastProvider + useToast hook.
 */
export function LumenToast({
  message,
  status = "info",
  lifecycleEvent,
  actions,
  duration = 5000,
  onDismiss,
}: LumenToastProps): React.ReactElement | null {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        setVisible(false);
        onDismiss?.();
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onDismiss]);

  if (!visible) return null;

  const toast: Toast = {
    id: "standalone",
    message,
    status,
    lifecycleEvent,
    actions,
    duration,
    createdAt: Date.now(),
  };

  return (
    <div
      className="lumen-toast-standalone"
      style={{
        position: "fixed",
        top: "1rem",
        right: "1rem",
        zIndex: 9999,
      }}
    >
      <LumenToastItem toast={toast} onRemove={() => {
        setVisible(false);
        onDismiss?.();
      }} />
    </div>
  );
}
