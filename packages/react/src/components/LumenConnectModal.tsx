"use client";

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { useCreateWallet } from "../use-create-wallet.js";
import { useCreateWalletWithPasskey } from "../use-create-wallet-with-passkey.js";

/** Minimal wallet shape emitted on successful authentication. */
export interface ConnectWalletResult {
  /** Stellar wallet address (public key). */
  address: string;
  /** Wallet identifier. */
  id: string;
}

export type LumenConnectModalTab = "create" | "connect";

/** Customizable visual theme for the modal. All fields are optional. */
export interface LumenConnectModalTheme {
  /** Primary accent color (active tab underline, primary buttons). */
  primaryColor?: string;
  /** Modal surface background color. */
  backgroundColor?: string;
  /** Primary text color. */
  textColor?: string;
  /** Secondary / muted text color. */
  mutedColor?: string;
  /** Border color for the modal and inputs. */
  borderColor?: string;
  /** Color used for error messages. */
  errorColor?: string;
  /** Font family applied to the modal. */
  fontFamily?: string;
  /** Base font size in pixels. */
  fontSize?: number;
  /** Border radius of the modal container (any CSS value). */
  borderRadius?: string;
  /** Border radius of buttons (any CSS value). */
  buttonBorderRadius?: string;
}

export interface LumenConnectModalProps {
  /** Controls whether the modal is visible. */
  open: boolean;
  /** Called when the modal is dismissed (overlay click, Escape, close button). */
  onClose: () => void;
  /** Called with the wallet once authentication succeeds. */
  onSuccess: (wallet: ConnectWalletResult) => void;
  /** Which tab is shown first. Defaults to "create". */
  defaultTab?: LumenConnectModalTab;
  /** Visual theme overrides. */
  theme?: LumenConnectModalTheme;
  /** Additional CSS class name(s) for the modal container. */
  className?: string;
  /** Dialog title. Defaults to "Connect Wallet". */
  title?: string;
}

const DEFAULT_THEME: Required<LumenConnectModalTheme> = {
  primaryColor: "var(--lumen-primary, #4f46e5)",
  backgroundColor: "var(--lumen-card-bg, #ffffff)",
  textColor: "var(--lumen-text, #111827)",
  mutedColor: "var(--lumen-text-muted, #6b7280)",
  borderColor: "var(--lumen-border, #e5e7eb)",
  errorColor: "var(--lumen-error, #dc2626)",
  fontFamily: "var(--lumen-font-family, inherit)",
  fontSize: 14,
  borderRadius: "var(--lumen-radius, 12px)",
  buttonBorderRadius: "var(--lumen-radius-sm, 8px)",
};

const TAB_CREATE: LumenConnectModalTab = "create";
const TAB_CONNECT: LumenConnectModalTab = "connect";

function mergeTheme(theme?: LumenConnectModalTheme): Required<LumenConnectModalTheme> {
  return { ...DEFAULT_THEME, ...(theme ?? {}) };
}

/**
 * A pre-built, responsive authentication and onboarding modal.
 *
 * Renders an accessible dialog (`role="dialog"`) with two built-in tabs:
 * "Create New Seedless Wallet" and "Connect Existing Device / Passkey".
 * On successful authentication the modal emits `onSuccess(wallet)` and closes.
 *
 * The dialog closes on overlay click, the Escape key, or the close button.
 * Visual appearance can be customized through the `theme` prop (colors,
 * typography, border radiuses) or a custom `className`.
 */
export function LumenConnectModal({
  open,
  onClose,
  onSuccess,
  defaultTab = TAB_CREATE,
  theme,
  className,
  title = "Connect Wallet",
}: LumenConnectModalProps): React.ReactElement | null {
  const t = mergeTheme(theme);
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [activeTab, setActiveTab] = useState<LumenConnectModalTab>(defaultTab);

  const createWallet = useCreateWallet();
  const connectPasskey = useCreateWalletWithPasskey();

  // Reset to the default tab whenever the modal is (re)opened.
  useEffect(() => {
    if (open) {
      setActiveTab(defaultTab);
      createWallet.reset();
      connectPasskey.reset();
    }
    // Only re-run when the modal opens/closes or the default tab changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultTab]);

  // Focus management: remember the previously focused element, move focus into
  // the dialog on open, trap Tab/Shift+Tab within it, and restore focus on close.
  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const getFocusable = (): HTMLElement[] => {
      const root = dialogRef.current;
      if (!root) return [];
      const selector =
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
      return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
    };

    // Initial focus: first focusable element, falling back to the dialog itself.
    const focusables = getFocusable();
    if (focusables.length > 0) {
      focusables[0].focus();
    } else if (dialogRef.current) {
      dialogRef.current.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const items = getFocusable();
      if (items.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !dialogRef.current?.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialogRef.current?.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === "function" && document.contains(previous)) {
        previous.focus();
      }
      previouslyFocusedRef.current = null;
    };
  }, [open, onClose]);

  const handleCreate = useCallback(async () => {
    try {
      const wallet = await createWallet.createWallet();
      onSuccess({ address: wallet.address, id: wallet.id });
      onClose();
    } catch {
      // Error state is surfaced through the hook's `error` field.
    }
  }, [createWallet, onSuccess, onClose]);

  const handleConnect = useCallback(async () => {
    try {
      const wallet = await connectPasskey.createWalletWithPasskey();
      onSuccess({ address: wallet.address, id: wallet.id });
      onClose();
    } catch {
      // Error state is surfaced through the hook's `error` field.
    }
  }, [connectPasskey, onSuccess, onClose]);

  if (!open) return null;

  const loading = createWallet.loading || connectPasskey.loading;
  const error = activeTab === TAB_CREATE ? createWallet.error : connectPasskey.error;

  const baseFont: React.CSSProperties = {
    fontFamily: t.fontFamily,
    fontSize: t.fontSize,
    color: t.textColor,
  };

  const tabButton = (tab: LumenConnectModalTab, label: string): React.ReactElement => {
    const selected = activeTab === tab;
    return (
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={`${titleId}-${tab}-panel`}
        id={`${titleId}-${tab}-tab`}
        onClick={() => setActiveTab(tab)}
        disabled={loading}
        style={{
          ...baseFont,
          flex: 1,
          padding: "10px 8px",
          background: "transparent",
          border: "none",
          borderBottom: selected ? `2px solid ${t.primaryColor}` : `2px solid ${t.borderColor}`,
          color: selected ? t.textColor : t.mutedColor,
          fontWeight: selected ? 600 : 400,
          cursor: loading ? "not-allowed" : "pointer",
        }}
      >
        {label}
      </button>
    );
  };

  const primaryButton: React.CSSProperties = {
    ...baseFont,
    width: "100%",
    padding: "12px",
    backgroundColor: t.primaryColor,
    color: "var(--lumen-primary-contrast, #ffffff)",
    border: "none",
    borderRadius: t.buttonBorderRadius,
    fontWeight: 600,
    cursor: loading ? "not-allowed" : "pointer",
    opacity: loading ? 0.7 : 1,
  };

  return (
    <div
      className="lumen-connect-modal__overlay"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "var(--lumen-overlay, rgba(0, 0, 0, 0.5))",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 1000,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className={["lumen-connect-modal", className].filter(Boolean).join(" ")}
        onClick={(event) => event.stopPropagation()}
        style={{
          ...baseFont,
          backgroundColor: t.backgroundColor,
          borderRadius: t.borderRadius,
          border: `1px solid ${t.borderColor}`,
          color: t.textColor,
          width: "100%",
          maxWidth: 420,
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
          padding: 24,
          boxShadow: "var(--lumen-shadow, 0 20px 50px rgba(0, 0, 0, 0.25))",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <h2 id={titleId} style={{ ...baseFont, margin: 0, fontSize: t.fontSize + 4, fontWeight: 700 }}>
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            style={{
              ...baseFont,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: t.mutedColor,
              fontSize: t.fontSize + 6,
              lineHeight: 1,
              padding: 4,
            }}
          >
            ×
          </button>
        </div>

        {/* Screen-reader description of the dialog */}
        <p id={descriptionId} style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
          Choose how to authenticate your Stellar wallet. Use the tabs to create a new seedless
          wallet or connect an existing device or passkey.
        </p>

        {/* Tabs */}
        <div role="tablist" aria-label="Authentication method" style={{ display: "flex", marginBottom: 20 }}>
          {tabButton(TAB_CREATE, "Create New Seedless Wallet")}
          {tabButton(TAB_CONNECT, "Connect Existing Device / Passkey")}
        </div>

        {/* Panels */}
        {activeTab === TAB_CREATE && (
          <div
            role="tabpanel"
            id={`${titleId}-${TAB_CREATE}-panel`}
            aria-labelledby={`${titleId}-${TAB_CREATE}-tab`}
          >
            <p style={{ ...baseFont, color: t.mutedColor, marginTop: 0, marginBottom: 16 }}>
              Create a new seedless wallet secured by your device. No seed phrase to back up.
            </p>
            <button type="button" onClick={() => void handleCreate()} disabled={loading} style={primaryButton}>
              {createWallet.loading ? "Creating wallet…" : "Create Seedless Wallet"}
            </button>
          </div>
        )}

        {activeTab === TAB_CONNECT && (
          <div
            role="tabpanel"
            id={`${titleId}-${TAB_CONNECT}-panel`}
            aria-labelledby={`${titleId}-${TAB_CONNECT}-tab`}
          >
            <p style={{ ...baseFont, color: t.mutedColor, marginTop: 0, marginBottom: 16 }}>
              Connect with a passkey on a device you already registered, or sign in with Google.
            </p>
            <button type="button" onClick={() => void handleConnect()} disabled={loading} style={primaryButton}>
              {connectPasskey.loading ? "Connecting…" : "Connect with Passkey"}
            </button>
          </div>
        )}

        {/* Live region announcing loading and error status to screen readers */}
        <div aria-live="polite" aria-atomic="true" role="status">
          {loading && (
            <p style={{ ...baseFont, color: t.mutedColor, marginTop: 12, marginBottom: 0 }}>
              {activeTab === TAB_CREATE ? "Creating wallet…" : "Connecting…"}
            </p>
          )}
          {error && (
            <p
              role="alert"
              style={{ ...baseFont, color: t.errorColor, marginTop: 12, marginBottom: 0 }}
            >
              {error.message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
