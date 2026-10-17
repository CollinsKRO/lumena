"use client";

import { createContext, useContext } from "react";
import type { LumenClient } from "@lumen/web-sdk";
import { useIsMounted } from "./hooks/use-is-mounted.js";

export interface LumenContextValue {
  client: LumenClient;
  /**
   * `true` once the provider has mounted on the client, `false` during
   * server-side rendering and hydration. Gate browser-only APIs
   * (`window.crypto`, `navigator.credentials`, …) behind this flag together
   * with `typeof window !== "undefined"` to avoid
   * `ReferenceError: window is not defined` on the server.
   */
  isMounted: boolean;
}

export const LumenContext = createContext<LumenContextValue | null>(null);

/**
 * `true` when running in a browser environment. Safe to evaluate during
 * React Server Component rendering because it never touches `window`
 * directly until the guard passes.
 */
export function isBrowserEnvironment(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * Creates a proxy that stands in for a `LumenClient` on the server. Any
 * property access or invocation throws a clear error explaining that a
 * browser environment is required, instead of failing with an opaque
 * `ReferenceError` or `TypeError` during RSC rendering.
 */
function createServerSafeClientProxy(): LumenClient {
  const thrower = (): never => {
    throw new Error(
      "@lumen/react: LumenClient requires a browser environment. " +
        "Render Lumen components inside a client component (\"use client\") " +
        "or use LumenServerProvider during React Server Component rendering.",
    );
  };

  return new Proxy({} as LumenClient, {
    get(_target, prop) {
      // Allow introspection helpers to behave sanely without throwing.
      if (prop === "then") {
        return undefined;
      }
      if (prop === Symbol.toStringTag) {
        return "LumenServerSafeClient";
      }
      if (typeof prop === "symbol") {
        return undefined;
      }
      return thrower;
    },
    apply() {
      return thrower();
    },
  });
}

/**
 * Server-safe fallback context value. `isMounted` is always `false` and the
 * `client` is a proxy that throws a descriptive error if used. This value is
 * safe to construct during RSC rendering and produces no hydration mismatch
 * because it matches the pre-mount client state.
 */
export const serverSafeLumenContextValue: LumenContextValue = {
  client: createServerSafeClientProxy(),
  isMounted: false,
};

export interface LumenProviderProps {
  client: LumenClient;
  /**
   * BCP-47 locale code used to translate all prebuilt Lumen UI components.
   * Supported values: "en" | "es" | "pt" | "fr" | "ja"
   * Defaults to "en".
   */
  locale?: LumenLocale;
  children: React.ReactNode;
}

export function LumenProvider({
  client,
  locale = "en",
  children,
}: LumenProviderProps) {
  const isMounted = useIsMounted();

  return (
    <LumenContext.Provider value={{ client, isMounted }}>
      {children}
    </LumenContext.Provider>
  );
}

export interface LumenServerProviderProps {
  /**
   * Optional client to expose on the server. When omitted, a server-safe
   * proxy is used that throws a descriptive error if any method is invoked.
   */
  client?: LumenClient;
  children: React.ReactNode;
}

/**
 * Server-safe mock provider for React Server Components. It supplies a
 * context value with `isMounted: false` so that components render their
 * pre-hydration state on the server, avoiding hydration mismatches. It never
 * accesses browser globals.
 */
export function LumenServerProvider({
  client,
  children,
}: LumenServerProviderProps) {
  const value: LumenContextValue = {
    client: client ?? serverSafeLumenContextValue.client,
    isMounted: false,
  };

  return (
    <LumenContext.Provider value={value}>{children}</LumenContext.Provider>
  );
}

export function useLumen(): LumenContextValue {
  const context = useContext(LumenContext);

  if (!context) {
    throw new Error("useLumen must be used within a LumenProvider");
  }

  return context;
}