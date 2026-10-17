/**
 * WebSocket streaming event client for Stellar Horizon and Soroban RPC.
 *
 * Provides long-lived subscriptions to:
 *  - Horizon payment operations
 *  - Horizon account updates
 *  - Soroban RPC contract events
 *
 * The client automatically reconnects on disconnect using exponential
 * backoff with jitter, and re-issues every active subscription, replaying
 * the last cursor per topic so no events are dropped.
 */

export type StreamTopic = 'payments' | 'account' | 'contract';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed';

export interface PaymentEvent {
  id: string;
  pagingToken: string;
  type: 'payment';
  account: string;
  from?: string;
  to?: string;
  amount?: string;
  asset?: string;
  raw: unknown;
}

export interface AccountEvent {
  id: string;
  pagingToken: string;
  type: 'account';
  account: string;
  raw: unknown;
}

export interface ContractEvent {
  id: string;
  pagingToken: string;
  type: 'contract';
  contractId: string;
  topic?: string[];
  value?: unknown;
  raw: unknown;
}

export type StreamEvent = PaymentEvent | AccountEvent | ContractEvent;

export interface SubscriptionParams {
  /** Horizon account for payments/account topics. */
  account?: string;
  /** Soroban contract id for contract topic. */
  contractId?: string;
  /** Optional topic filter for Soroban contract events. */
  topics?: string[];
  /** Optional starting cursor. */
  cursor?: string;
}

export interface Subscription {
  id: string;
  topic: StreamTopic;
  params: SubscriptionParams;
  cursor?: string;
  active: boolean;
}

export interface StreamClientOptions {
  /** Horizon base URL, e.g. https://horizon-testnet.stellar.org */
  horizonUrl?: string;
  /** Soroban RPC base URL, e.g. https://soroban-testnet.stellar.org */
  sorobanUrl?: string;
  /** Initial reconnect delay in ms. Default 1000. */
  initialBackoffMs?: number;
  /** Maximum reconnect delay in ms. Default 30000. */
  maxBackoffMs?: number;
  /** Backoff multiplier. Default 2. */
  backoffFactor?: number;
  /** Jitter ratio (0..1) applied to each delay. Default 0.2. */
  jitterRatio?: number;
  /** WebSocket factory, injectable for testing. */
  webSocketFactory?: (url: string) => WebSocketLike;
  /** Timer functions, injectable for testing. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface StreamClientEvents {
  event: (event: StreamEvent, subscription: Subscription) => void;
  state: (state: ConnectionState) => void;
  error: (error: Error) => void;
}

type EventName = keyof StreamClientEvents;

const WS_OPEN = 1;

let subscriptionCounter = 0;

function nextSubscriptionId(): string {
  subscriptionCounter += 1;
  return `sub_${subscriptionCounter}_${Date.now().toString(36)}`;
}

function toWebSocketUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.startsWith('https://')) {
    return `wss://${trimmed.slice('https://'.length)}${path}`;
  }
  if (trimmed.startsWith('http://')) {
    return `ws://${trimmed.slice('http://'.length)}${path}`;
  }
  if (trimmed.startsWith('wss://') || trimmed.startsWith('ws://')) {
    return `${trimmed}${path}`;
  }
  return `wss://${trimmed}${path}`;
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  const Ctor: any =
    (typeof globalThis !== 'undefined' && (globalThis as any).WebSocket) ||
    undefined;
  if (!Ctor) {
    throw new Error('No WebSocket implementation available');
  }
  return new Ctor(url) as WebSocketLike;
}

export class StreamClient {
  private readonly horizonUrl: string;
  private readonly sorobanUrl: string;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly backoffFactor: number;
  private readonly jitterRatio: number;
  private readonly webSocketFactory: (url: string) => WebSocketLike;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  private subscriptions = new Map<string, Subscription>();
  private sockets = new Map<string, WebSocketLike>();
  private listeners: { [K in EventName]: Set<StreamClientEvents[K]> } = {
    event: new Set(),
    state: new Set(),
    error: new Set(),
  };

  private state: ConnectionState = 'idle';
  private reconnectAttempts = 0;
  private reconnectTimer: unknown = null;
  private closed = false;

  constructor(options: StreamClientOptions = {}) {
    this.horizonUrl = options.horizonUrl ?? 'https://horizon.stellar.org';
    this.sorobanUrl = options.sorobanUrl ?? 'https://soroban-testnet.stellar.org';
    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.jitterRatio = options.jitterRatio ?? 0.2;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.setTimeoutFn =
      options.setTimeoutFn ??
      ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Current connection state. */
  getState(): ConnectionState {
    return this.state;
  }

  /** Snapshot of active subscriptions. */
  getSubscriptions(): Subscription[] {
    return Array.from(this.subscriptions.values()).map((s) => ({ ...s }));
  }

  on<K extends EventName>(event: K, listener: StreamClientEvents[K]): () => void {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  off<K extends EventName>(event: K, listener: StreamClientEvents[K]): void {
    this.listeners[event].delete(listener);
  }

  /**
   * Subscribe to a stream topic. Returns the subscription id.
   */
  subscribe(topic: StreamTopic, params: SubscriptionParams = {}): string {
    if (this.closed) {
      throw new Error('StreamClient is closed');
    }
    const id = nextSubscriptionId();
    const subscription: Subscription = {
      id,
      topic,
      params: { ...params },
      cursor: params.cursor,
      active: true,
    };
    this.subscriptions.set(id, subscription);
    this.openSubscription(subscription);
    return id;
  }

  /** Unsubscribe and close the underlying socket for a subscription. */
  unsubscribe(id: string): boolean {
    const subscription = this.subscriptions.get(id);
    if (!subscription) {
      return false;
    }
    subscription.active = false;
    this.subscriptions.delete(id);
    const socket = this.sockets.get(id);
    if (socket) {
      this.sockets.delete(id);
      try {
        socket.close(1000, 'unsubscribe');
      } catch {
        /* ignore */
      }
    }
    return true;
  }

  /** Close all subscriptions and stop reconnecting. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [id, socket] of this.sockets) {
      this.sockets.delete(id);
      try {
        socket.close(1000, 'client close');
      } catch {
        /* ignore */
      }
    }
    for (const subscription of this.subscriptions.values()) {
      subscription.active = false;
    }
    this.subscriptions.clear();
    this.setState('closed');
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private setState(state: ConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    for (const listener of this.listeners.state) {
      try {
        listener(state);
      } catch (err) {
        this.emitError(err);
      }
    }
  }

  private emitError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    for (const listener of this.listeners.error) {
      try {
        listener(error);
      } catch {
        /* swallow listener errors */
      }
    }
  }

  private emitEvent(event: StreamEvent, subscription: Subscription): void {
    for (const listener of this.listeners.event) {
      try {
        listener(event, subscription);
      } catch (err) {
        this.emitError(err);
      }
    }
  }

  private buildUrl(subscription: Subscription): string {
    const { topic, params, cursor } = subscription;
    if (topic === 'contract') {
      return toWebSocketUrl(this.sorobanUrl, '/events');
    }
    if (topic === 'account') {
      const account = params.account ?? '';
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      return toWebSocketUrl(
        this.horizonUrl,
        `/accounts/${encodeURIComponent(account)}${query}`,
      );
    }
    // payments
    const account = params.account ?? '';
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return toWebSocketUrl(
      this.horizonUrl,
      `/accounts/${encodeURIComponent(account)}/payments${query}`,
    );
  }

  private buildSubscribeMessage(subscription: Subscription): string {
    const { topic, params, cursor } = subscription;
    if (topic === 'contract') {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: subscription.id,
        method: 'subscribe',
        params: {
          contractId: params.contractId,
          topics: params.topics,
          cursor,
        },
      });
    }
    return JSON.stringify({
      type: 'subscribe',
      topic,
      account: params.account,
      cursor,
    });
  }

  private openSubscription(subscription: Subscription): void {
    if (this.closed || !subscription.active) {
      return;
    }
    let socket: WebSocketLike;
    try {
      socket = this.webSocketFactory(this.buildUrl(subscription));
    } catch (err) {
      this.emitError(err);
      this.scheduleReconnect();
      return;
    }

    this.sockets.set(subscription.id, socket);
    if (this.state !== 'open') {
      this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    }

    socket.onopen = () => {
      if (this.closed || !subscription.active) {
        return;
      }
      try {
        socket.send(this.buildSubscribeMessage(subscription));
      } catch (err) {
        this.emitError(err);
      }
      this.reconnectAttempts = 0;
      this.setState('open');
    };

    socket.onmessage = (ev: { data: unknown }) => {
      this.handleMessage(subscription, ev.data);
    };

    socket.onerror = (ev: unknown) => {
      this.emitError(ev instanceof Error ? ev : new Error('WebSocket error'));
    };

    socket.onclose = () => {
      this.sockets.delete(subscription.id);
      if (this.closed || !subscription.active) {
        return;
      }
      this.scheduleReconnect();
    };
  }

  private handleMessage(subscription: Subscription, data: unknown): void {
    if (typeof data !== 'string') {
      return;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const event = this.normalizeEvent(subscription, parsed);
    if (!event) {
      return;
    }
    if (event.pagingToken) {
      subscription.cursor = event.pagingToken;
    }
    this.emitEvent(event, subscription);
  }

  private normalizeEvent(
    subscription: Subscription,
    parsed: any,
  ): StreamEvent | null {
    const pagingToken: string =
      parsed?.paging_token ?? parsed?.pagingToken ?? parsed?.cursor ?? '';
    const id: string = parsed?.id ?? pagingToken;

    if (subscription.topic === 'contract') {
      return {
        id,
        pagingToken,
        type: 'contract',
        contractId:
          parsed?.contractId ?? subscription.params.contractId ?? '',
        topic: parsed?.topic ?? parsed?.topics,
        value: parsed?.value,
        raw: parsed,
      };
    }

    if (subscription.topic === 'account') {
      return {
        id,
        pagingToken,
        type: 'account',
        account: parsed?.account ?? subscription.params.account ?? '',
        raw: parsed,
      };
    }

    return {
      id,
      pagingToken,
      type: 'payment',
      account: parsed?.account ?? subscription.params.account ?? '',
      from: parsed?.from,
      to: parsed?.to,
      amount: parsed?.amount,
      asset: parsed?.asset,
      raw: parsed,
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) {
      return;
    }
    if (this.subscriptions.size === 0) {
      this.setState('idle');
      return;
    }
    this.setState('reconnecting');

    const delay = this.computeBackoff(this.reconnectAttempts);
    this.reconnectAttempts += 1;

    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this.reconnectAll();
    }, delay);
  }

  private reconnectAll(): void {
    if (this.closed) {
      return;
    }
    for (const subscription of this.subscriptions.values()) {
      if (!subscription.active) {
        continue;
      }
      if (this.sockets.has(subscription.id)) {
        continue;
      }
      // Re-issue the subscription, replaying the last cursor.
      this.openSubscription(subscription);
    }
  }

  private computeBackoff(attempt: number): number {
    const base = this.initialBackoffMs * Math.pow(this.backoffFactor, attempt);
    const capped = Math.min(base, this.maxBackoffMs);
    const jitter = capped * this.jitterRatio * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(capped + jitter));
  }
}

export default StreamClient;
```

Now the unit tests:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StreamClient,
  WebSocketLike,
  StreamEvent,
  ConnectionState,
} from '../stream';

class MockWebSocket implements WebSocketLike {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  url: string;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    if (this.onclose) {
      this.onclose({});
    }
  }

  simulateOpen(): void {
    this.readyState = 1;
    if (this.onopen) {
      this.onopen({});
    }
  }

  simulateMessage(data: unknown): void {
    if (this.onmessage) {
      this.onmessage({ data });
    }
  }

  simulateClose(): void {
    this.readyState = 3;
    if (this.onclose) {
      this.onclose({});
    }
  }
}

describe('StreamClient', () => {
  let timers: Array<{ fn: () => void; ms: number; handle: number }>;
  let timerId: number;

  beforeEach(() => {
    MockWebSocket.instances = [];
    timers = [];
    timerId = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createClient(overrides: Record<string, unknown> = {}) {
    return new StreamClient({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      sorobanUrl: 'https://soroban-testnet.stellar.org',
      webSocketFactory: (url: string) => new MockWebSocket(url),
      setTimeoutFn: (fn: () => void, ms: number) => {
        const handle = ++timerId;
        timers.push({ fn, ms, handle });
        return handle;
      },
      clearTimeoutFn: (handle: unknown) => {
        timers = timers.filter((t) => t.handle !== handle);
      },
      ...overrides,
    });
  }

  function flushTimers() {
    const pending = timers;
    timers = [];
    for (const t of pending) {
      t.fn();
    }
  }

  it('opens a Horizon payments subscription and emits events', () => {
    const client = createClient();
    const events: StreamEvent[] = [];
    client.on('event', (e) => events.push(e));

    const id = client.subscribe('payments', { account: 'GABC' });
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toContain('/accounts/GABC/payments');

    ws.simulateOpen();
    expect(client.getState()).toBe('open');
    expect(ws.sent).toHaveLength(1);

    ws.simulateMessage(
      JSON.stringify({
        id: '1',
        paging_token: 'cursor-1',
        from: 'GA',
        to: 'GB',
        amount: '10',
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('payment');
    expect(events[0].pagingToken).toBe('cursor-1');

    const subs = client.getSubscriptions();
    expect(subs[0].cursor).toBe('cursor-1');
    expect(subs[0].id).toBe(id);
  });

  it('opens a Soroban contract subscription', () => {
    const client = createClient();
    client.subscribe('contract', { contractId: 'C123', topics: ['t1'] });
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toContain('/events');
    ws.simulateOpen();
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.method).toBe('subscribe');
    expect(msg.params.contractId).toBe('C123');
  });

  it('reconnects on disconnect with exponential backoff', () => {
    const client = createClient({ initialBackoffMs: 100, jitterRatio: 0 });
    client.subscribe('payments', { account: 'GABC' });
    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();
    expect(client.getState()).toBe('open');

    ws1.simulateClose();
    expect(client.getState()).toBe('reconnecting');
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(100);

    flushTimers();
    expect(MockWebSocket.instances).toHaveLength(2);
    const ws2 = MockWebSocket.instances[1];
    ws2.simulateOpen();
    expect(client.getState()).toBe('open');

    // Second disconnect should back off further.
    ws2.simulateClose();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(200);
  });

  it('resubscribes without dropping state, replaying the last cursor', () => {
    const client = createClient({ initialBackoffMs: 50, jitterRatio: 0 });
    client.subscribe('payments', { account: 'GABC' });
    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();
    ws1.simulateMessage(
      JSON.stringify({ id: '1', paging_token: 'cursor-42', amount: '1' }),
    );

    ws1.simulateClose();
    flushTimers();

    expect(MockWebSocket.instances).toHaveLength(2);
    const ws2 = MockWebSocket.instances[1];
    expect(ws2.url).toContain('cursor=cursor-42');

    ws2.simulateOpen();
    const msg = JSON.parse(ws2.sent[0]);
    expect(msg.cursor).toBe('cursor-42');

    // Subscription registry preserved.
    const subs = client.getSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].cursor).toBe('cursor-42');
  });

  it('re-issues all active subscriptions on reconnect', () => {
    const client = createClient({ initialBackoffMs: 10, jitterRatio: 0 });
    client.subscribe('payments', { account: 'GABC' });
    client.subscribe('account', { account: 'GABC' });
    client.subscribe('contract', { contractId: 'C1' });
    expect(MockWebSocket.instances).toHaveLength(3);

    MockWebSocket.instances.forEach((ws) => ws.simulateOpen());
    MockWebSocket.instances[0].simulateClose();

    flushTimers();
    // Only the closed one should be reopened.
    expect(MockWebSocket.instances).toHaveLength(4);
    expect(client.getSubscriptions()).toHaveLength(3);
  });

  it('emits connection state changes', () => {
    const client = createClient();
    const states: ConnectionState[] = [];
    client.on('state', (s) => states.push(s));

    client.subscribe('payments', { account: 'GABC' });
    MockWebSocket.instances[0].simulateOpen();
    MockWebSocket.instances[0].simulateClose();

    expect(states).toContain('connecting');
    expect(states).toContain('open');
    expect(states).toContain('reconnecting');
  });

  it('unsubscribe stops reconnection for that subscription', () => {
    const client = createClient({ initialBackoffMs: 10, jitterRatio: 0 });
    const id = client.subscribe('payments', { account: 'GABC' });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    client.unsubscribe(id);
    expect(client.getSubscriptions()).toHaveLength(0);

    ws.simulateClose();
    flushTimers();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('close stops all reconnection and clears subscriptions', () => {
    const client = createClient({ initialBackoffMs: 10, jitterRatio: 0 });
    client.subscribe('payments', { account: 'GABC' });
    MockWebSocket.instances[0].simulateOpen();

    client.close();
    expect(client.getState()).toBe('closed');
    expect(client.getSubscriptions()).toHaveLength(0);

    flushTimers();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('caps backoff at maxBackoffMs', () => {
    const client = createClient({
      initialBackoffMs: 100,
      maxBackoffMs: 300,
      backoffFactor: 2,
      jitterRatio: 0,
    });
    client.subscribe('payments', { account: 'GABC' });
    let ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      ws.simulateClose();
      expect(timers).toHaveLength(1);
      delays.push(timers[0].ms);
      flushTimers();
      ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      ws.simulateOpen();
    }

    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(200);
    expect(delays[2]).toBe(300);
    expect(delays[3]).toBe(300);
    expect(delays[4]).toBe(300);
  });
});