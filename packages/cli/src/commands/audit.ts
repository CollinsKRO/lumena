import { Command } from 'commander';
import WebSocket from 'ws';

export interface AuditEvent {
  type?: string;
  decision?: string;
  status?: string;
  approved?: boolean;
  wallet?: string;
  walletId?: string;
  txHash?: string;
  transactionHash?: string;
  fee?: number | string;
  reason?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface FormatAuditEventOptions {
  color?: boolean;
}

export interface AuditCommandDeps {
  WebSocketImpl?: typeof WebSocket;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  exit?: (code?: number) => void;
}

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

function isApproval(event: AuditEvent): boolean {
  if (typeof event.approved === 'boolean') {
    return event.approved;
  }
  const decision = (event.decision ?? event.status ?? event.type ?? '').toString().toLowerCase();
  if (decision.includes('approv') || decision.includes('accept') || decision.includes('allow')) {
    return true;
  }
  if (decision.includes('reject') || decision.includes('den') || decision.includes('deny')) {
    return false;
  }
  return false;
}

function pickWallet(event: AuditEvent): string {
  return (event.wallet ?? event.walletId ?? 'unknown').toString();
}

function pickTxHash(event: AuditEvent): string {
  return (event.txHash ?? event.transactionHash ?? 'unknown').toString();
}

function pickFee(event: AuditEvent): string {
  if (event.fee === undefined || event.fee === null) {
    return 'n/a';
  }
  return event.fee.toString();
}

/**
 * Pure formatter for a single audit event. When `color` is true, approvals are
 * rendered in green and rejections in red; otherwise plain text is produced.
 */
export function formatAuditEvent(event: AuditEvent, options: FormatAuditEventOptions = {}): string {
  const color = options.color === true;
  const approved = isApproval(event);
  const label = approved ? 'APPROVED' : 'REJECTED';
  const wallet = pickWallet(event);
  const txHash = pickTxHash(event);
  const fee = pickFee(event);
  const reason = event.reason ? event.reason.toString() : '';
  const timestamp = event.timestamp ? event.timestamp.toString() : '';

  const parts: string[] = [];
  if (timestamp) {
    parts.push(color ? `${DIM}${timestamp}${RESET}` : timestamp);
  }

  if (color) {
    const statusColor = approved ? GREEN : RED;
    parts.push(`${statusColor}${BOLD}${label}${RESET}`);
  } else {
    parts.push(label);
  }

  parts.push(`wallet=${wallet}`);
  parts.push(`tx=${txHash}`);
  parts.push(`fee=${fee}`);

  if (reason) {
    parts.push(`reason=${reason}`);
  }

  return parts.join(' ');
}

function deriveWebSocketUrl(server: string): string {
  const trimmed = server.trim();
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return trimmed.replace(/\/+$/, '') + '/audit/stream';
  }
  if (trimmed.startsWith('https://')) {
    return 'wss://' + trimmed.slice('https://'.length).replace(/\/+$/, '') + '/audit/stream';
  }
  if (trimmed.startsWith('http://')) {
    return 'ws://' + trimmed.slice('http://'.length).replace(/\/+$/, '') + '/audit/stream';
  }
  return 'ws://' + trimmed.replace(/\/+$/, '') + '/audit/stream';
}

export function registerAuditCommand(program: Command, deps: AuditCommandDeps = {}): void {
  const WebSocketImpl = deps.WebSocketImpl ?? WebSocket;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const exit = deps.exit ?? ((code?: number) => process.exit(code));

  program
    .command('audit')
    .description('Stream real-time policy decisions from a Lumen server')
    .requiredOption('--server <url>', 'Lumen server URL (http(s) or ws(s))')
    .option('--follow', 'continuously stream events until interrupted', false)
    .action(async (options: { server: string; follow?: boolean }) => {
      const jsonOutput = Boolean((program.opts() as { json?: boolean }).json);
      const url = deriveWebSocketUrl(options.server);
      const follow = Boolean(options.follow);

      let closed = false;
      let socket: WebSocket | null = null;
      let reconnectAttempts = 0;
      let reconnectTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (closed) {
          return;
        }
        closed = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (socket) {
          try {
            socket.removeAllListeners();
            socket.close();
          } catch {
            /* ignore */
          }
          socket = null;
        }
      };

      const shutdown = (code: number) => {
        cleanup();
        exit(code);
      };

      const onSigint = () => {
        shutdown(0);
      };
      process.once('SIGINT', onSigint);

      const connect = () => {
        if (closed) {
          return;
        }

        let ws: WebSocket;
        try {
          ws = new WebSocketImpl(url);
        } catch (err) {
          stderr.write(`Failed to open audit stream: ${(err as Error).message}\n`);
          cleanup();
          exit(1);
          return;
        }
        socket = ws;

        ws.on('open', () => {
          reconnectAttempts = 0;
          if (!jsonOutput) {
            stdout.write(`${BOLD}Connected to ${url}${RESET}\n`);
          }
        });

        ws.on('message', (data: WebSocket.RawData) => {
          const text = data.toString();
          let event: AuditEvent;
          try {
            event = JSON.parse(text) as AuditEvent;
          } catch {
            if (jsonOutput) {
              stdout.write(text + '\n');
            } else {
              stdout.write(`${DIM}${text}${RESET}\n`);
            }
            if (!follow) {
              shutdown(0);
            }
            return;
          }

          if (jsonOutput) {
            stdout.write(JSON.stringify(event) + '\n');
          } else {
            stdout.write(formatAuditEvent(event, { color: true }) + '\n');
          }

          if (!follow) {
            shutdown(0);
          }
        });

        ws.on('error', (err: Error) => {
          stderr.write(`Audit stream error: ${err.message}\n`);
        });

        ws.on('close', () => {
          if (closed) {
            return;
          }
          if (!follow) {
            shutdown(0);
            return;
          }
          reconnectAttempts += 1;
          const delay = Math.min(30000, 500 * Math.pow(2, reconnectAttempts - 1));
          if (!jsonOutput) {
            stderr.write(`${DIM}Disconnected. Reconnecting in ${delay}ms...${RESET}\n`);
          }
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, delay);
        });
      };

      connect();
    });
}
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>