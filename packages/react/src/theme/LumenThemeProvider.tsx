'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  LumenThemeMode,
  LumenResolvedTheme,
  LumenThemeTokens,
  lightTokens,
  darkTokens,
  tokensToCssVariables,
} from './tokens';

export interface LumenThemeContextValue {
  /** The mode requested by the consumer: 'dark' | 'light' | 'system'. */
  mode: LumenThemeMode;
  /** The actual theme applied after resolving 'system'. */
  resolvedTheme: LumenResolvedTheme;
  /** The active design tokens for the resolved theme. */
  tokens: LumenThemeTokens;
  /** Update the theme mode. */
  setMode: (mode: LumenThemeMode) => void;
  /** Toggle between light and dark (resolves 'system' to its opposite). */
  toggleTheme: () => void;
}

const LumenThemeContext = createContext<LumenThemeContextValue | null>(null);

export interface LumenThemeProviderProps {
  children?: React.ReactNode;
  /** Initial theme mode. Defaults to 'system'. */
  defaultMode?: LumenThemeMode;
  /** Controlled theme mode. When provided, the provider becomes controlled. */
  mode?: LumenThemeMode;
  /** Called whenever the mode changes (useful for controlled usage). */
  onModeChange?: (mode: LumenThemeMode) => void;
  /** Optional className applied to the wrapper element. */
  className?: string;
  /** Optional inline style merged onto the wrapper element. */
  style?: React.CSSProperties;
  /** Render without a wrapper element (variables applied to document root). */
  noWrapper?: boolean;
}

const SYSTEM_QUERY = '(prefers-color-scheme: dark)';

function getSystemTheme(): LumenResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia(SYSTEM_QUERY).matches ? 'dark' : 'light';
}

function resolveTheme(
  mode: LumenThemeMode,
  systemTheme: LumenResolvedTheme,
): LumenResolvedTheme {
  if (mode === 'system') {
    return systemTheme;
  }
  return mode;
}

export function LumenThemeProvider({
  children,
  defaultMode = 'system',
  mode: controlledMode,
  onModeChange,
  className,
  style,
  noWrapper = false,
}: LumenThemeProviderProps) {
  const isControlled = controlledMode !== undefined;
  const [internalMode, setInternalMode] = useState<LumenThemeMode>(defaultMode);
  const [systemTheme, setSystemTheme] = useState<LumenResolvedTheme>(() =>
    getSystemTheme(),
  );

  const mode = isControlled ? (controlledMode as LumenThemeMode) : internalMode;

  // Subscribe to system preference changes.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia(SYSTEM_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };

    // Sync initial value in case it changed between render and effect.
    setSystemTheme(mediaQuery.matches ? 'dark' : 'light');

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    // Legacy Safari fallback.
    if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    }

    return undefined;
  }, []);

  const resolvedTheme = resolveTheme(mode, systemTheme);
  const tokens = resolvedTheme === 'dark' ? darkTokens : lightTokens;

  const setMode = useCallback(
    (nextMode: LumenThemeMode) => {
      if (!isControlled) {
        setInternalMode(nextMode);
      }
      onModeChange?.(nextMode);
    },
    [isControlled, onModeChange],
  );

  const toggleTheme = useCallback(() => {
    const next: LumenThemeMode = resolvedTheme === 'dark' ? 'light' : 'dark';
    setMode(next);
  }, [resolvedTheme, setMode]);

  const cssVariables = useMemo(() => tokensToCssVariables(tokens), [tokens]);

  // When rendering without a wrapper, apply variables to the document root.
  useEffect(() => {
    if (!noWrapper || typeof document === 'undefined') {
      return;
    }
    const root = document.documentElement;
    const previousTheme = root.getAttribute('data-lumen-theme');
    const previousValues: Record<string, string> = {};

    root.setAttribute('data-lumen-theme', resolvedTheme);
    Object.entries(cssVariables).forEach(([key, value]) => {
      previousValues[key] = root.style.getPropertyValue(key);
      root.style.setProperty(key, value);
    });

    return () => {
      if (previousTheme === null) {
        root.removeAttribute('data-lumen-theme');
      } else {
        root.setAttribute('data-lumen-theme', previousTheme);
      }
      Object.entries(previousValues).forEach(([key, value]) => {
        if (value) {
          root.style.setProperty(key, value);
        } else {
          root.style.removeProperty(key);
        }
      });
    };
  }, [noWrapper, resolvedTheme, cssVariables]);

  const contextValue = useMemo<LumenThemeContextValue>(
    () => ({
      mode,
      resolvedTheme,
      tokens,
      setMode,
      toggleTheme,
    }),
    [mode, resolvedTheme, tokens, setMode, toggleTheme],
  );

  const wrapperStyle: React.CSSProperties = noWrapper
    ? {}
    : { ...(cssVariables as React.CSSProperties), ...style };

  const content = (
    <LumenThemeContext.Provider value={contextValue}>
      {children}
    </LumenThemeContext.Provider>
  );

  if (noWrapper) {
    return content;
  }

  return (
    <div
      data-lumen-theme={resolvedTheme}
      className={className}
      style={wrapperStyle}
    >
      {content}
    </div>
  );
}

export function useLumenTheme(): LumenThemeContextValue {
  const context = useContext(LumenThemeContext);
  if (!context) {
    throw new Error(
      'useLumenTheme must be used within a <LumenThemeProvider>.',
    );
  }
  return context;
}

export default LumenThemeProvider;