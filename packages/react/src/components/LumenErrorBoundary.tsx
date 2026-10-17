import React from 'react';

/**
 * LumenErrorBoundary
 *
 * A React error boundary that gracefully catches unexpected cryptographic
 * errors or network failures thrown by child components, renders a friendly
 * fallback UI, and allows the user to copy a sanitized diagnostic payload
 * for crash reporting.
 *
 * Security note: Before exporting diagnostics, any keys that look like
 * secrets (private keys, mnemonics, passwords, tokens, etc.) are recursively
 * stripped and their values redacted so that sensitive material never leaves
 * the application.
 */

export interface LumenErrorBoundaryProps {
  /** Child components to guard. */
  children?: React.ReactNode;
  /** Optional custom fallback renderer. */
  fallback?: (props: LumenErrorFallbackProps) => React.ReactNode;
  /** Optional callback invoked when an error is caught. */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  /** Optional additional context to include in diagnostics (will be sanitized). */
  diagnosticsContext?: Record<string, unknown>;
}

export interface LumenErrorFallbackProps {
  error: Error;
  errorInfo: React.ErrorInfo | null;
  resetErrorBoundary: () => void;
  copyDiagnostics: () => Promise<boolean>;
  diagnostics: string;
}

export interface LumenErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

const REDACTED = '[REDACTED]';

/**
 * Keys (case-insensitive, substring match) that indicate sensitive data.
 */
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /secret/i,
  /private[_-]?key/i,
  /privatekey/i,
  /mnemonic/i,
  /seed[_-]?phrase/i,
  /seedphrase/i,
  /password/i,
  /passphrase/i,
  /token/i,
  /api[_-]?key/i,
  /apikey/i,
  /authorization/i,
  /credential/i,
  /signature/i,
  /xprv/i,
  /xpub/i,
];

const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));

/**
 * Recursively sanitize an arbitrary value, stripping sensitive keys and
 * redacting their values. Handles plain objects, arrays, Errors, Dates,
 * Maps, Sets, and primitives. Guards against circular references.
 */
export function sanitizeDiagnostics(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
  if (depth > 20) {
    return '[MaxDepthExceeded]';
  }

  if (value === null || value === undefined) {
    return value;
  }

  const valueType = typeof value;

  if (
    valueType === 'string' ||
    valueType === 'number' ||
    valueType === 'boolean' ||
    valueType === 'bigint'
  ) {
    return value;
  }

  if (valueType === 'function') {
    return '[Function]';
  }

  if (valueType === 'symbol') {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === 'object') {
    const obj = value as object;

    if (seen.has(obj)) {
      return '[Circular]';
    }
    seen.add(obj);

    if (Array.isArray(value)) {
      return value.map((item) => sanitizeDiagnostics(item, seen, depth + 1));
    }

    if (value instanceof Map) {
      const result: Record<string, unknown> = {};
      value.forEach((mapValue, mapKey) => {
        const keyStr = String(mapKey);
        result[keyStr] = isSensitiveKey(keyStr)
          ? REDACTED
          : sanitizeDiagnostics(mapValue, seen, depth + 1);
      });
      return result;
    }

    if (value instanceof Set) {
      return Array.from(value).map((item) =>
        sanitizeDiagnostics(item, seen, depth + 1),
      );
    }

    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED;
      } else {
        result[key] = sanitizeDiagnostics(
          (value as Record<string, unknown>)[key],
          seen,
          depth + 1,
        );
      }
    }
    return result;
  }

  return String(value);
}

/**
 * Build the sanitized diagnostic JSON payload for an error.
 */
export function buildDiagnosticsPayload(
  error: Error,
  errorInfo: React.ErrorInfo | null,
  context?: Record<string, unknown>,
): string {
  const payload = {
    timestamp: new Date().toISOString(),
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack,
    },
    componentStack: errorInfo?.componentStack ?? null,
    context: context ? sanitizeDiagnostics(context) : null,
    userAgent:
      typeof navigator !== 'undefined' && navigator.userAgent
        ? navigator.userAgent
        : null,
  };

  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      error: {
        name: error.name,
        message: error.message,
        stack: '[Unserializable]',
      },
      componentStack: null,
      context: null,
    });
  }
}

export class LumenErrorBoundary extends React.Component<
  LumenErrorBoundaryProps,
  LumenErrorBoundaryState
> {
  constructor(props: LumenErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
    this.resetErrorBoundary = this.resetErrorBoundary.bind(this);
    this.copyDiagnostics = this.copyDiagnostics.bind(this);
  }

  static getDerivedStateFromError(error: Error): Partial<LumenErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ errorInfo });

    if (typeof this.props.onError === 'function') {
      try {
        this.props.onError(error, errorInfo);
      } catch {
        // Never let a reporting callback crash the boundary itself.
      }
    }
  }

  resetErrorBoundary(): void {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  }

  getDiagnostics(): string {
    const { error, errorInfo } = this.state;
    if (!error) {
      return '';
    }
    return buildDiagnosticsPayload(error, errorInfo, this.props.diagnosticsContext);
  }

  async copyDiagnostics(): Promise<boolean> {
    const diagnostics = this.getDiagnostics();
    if (!diagnostics) {
      return false;
    }

    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        await navigator.clipboard.writeText(diagnostics);
        return true;
      }
    } catch {
      // Fall through to legacy fallback below.
    }

    // Legacy fallback for environments without the async clipboard API.
    try {
      if (typeof document === 'undefined') {
        return false;
      }
      const textarea = document.createElement('textarea');
      textarea.value = diagnostics;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'absolute';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      const success = document.execCommand('copy');
      document.body.removeChild(textarea);
      return success;
    } catch {
      return false;
    }
  }

  render(): React.ReactNode {
    const { hasError, error, errorInfo } = this.state;

    if (!hasError || !error) {
      return this.props.children;
    }

    const diagnostics = this.getDiagnostics();

    if (typeof this.props.fallback === 'function') {
      return this.props.fallback({
        error,
        errorInfo,
        resetErrorBoundary: this.resetErrorBoundary,
        copyDiagnostics: this.copyDiagnostics,
        diagnostics,
      });
    }

    return (
      <div
        role="alert"
        data-testid="lumen-error-boundary-fallback"
        style={{
          padding: '24px',
          borderRadius: '8px',
          border: '1px solid #e0b4b4',
          background: '#fff5f5',
          color: '#5a1a1a',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <h2 style={{ margin: '0 0 8px', fontSize: '18px' }}>
          Something went wrong
        </h2>
        <p style={{ margin: '0 0 16px', fontSize: '14px', lineHeight: 1.5 }}>
          Lumen encountered an unexpected error. Your funds and keys are safe.
          You can try again, or copy the error diagnostics to share with support.
        </p>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={this.copyDiagnostics}
            data-testid="lumen-error-boundary-copy"
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid #5a1a1a',
              background: '#5a1a1a',
              color: '#ffffff',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            Copy Error Diagnostics
          </button>
          <button
            type="button"
            onClick={this.resetErrorBoundary}
            data-testid="lumen-error-boundary-reset"
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid #5a1a1a',
              background: 'transparent',
              color: '#5a1a1a',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }
}

export default LumenErrorBoundary;