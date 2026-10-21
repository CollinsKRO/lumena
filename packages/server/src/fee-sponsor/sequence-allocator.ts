/**
 * Distributed sequence-number allocator for the fee-sponsor account.
 *
 * Stellar accounts require strictly consecutive sequence numbers, so two
 * replicas co-signing on behalf of the same sponsor account would otherwise
 * race and produce `txBAD_SEQ` collisions. The allocator hands out sequence
 * numbers from a shared Redis counter and records a short-lived reservation
 * for each one, so that a reservation can be released (the transaction was
 * not submitted) or committed (the sequence was consumed by the ledger).
 *
 * State layout (all keys are namespaced under {@link SequenceAllocatorOptions.key}):
 *
 *   `{key}:seq`            monotonic slot counter (INCR)
 *   `{key}:res:{slot}`     live reservation, holding the owning account, with a TTL
 *   `{key}:claimed:{slot}` marker set while a slot is reserved but not yet released
 *   `{key}:used:{slot}`    marker set once a slot has been committed
 *   `{key}:reserved`       counter of reservations handed out
 *   `{key}:released`       counter of reservations released, committed or reclaimed
 *
 * `pendingReservations()` is derived from the two counters, which keeps it
 * O(1) and safe to call concurrently: both counters are only ever mutated
 * with `INCR`, so no update can be lost.
 */

/** Minimal Redis surface required by the allocator. */
export interface SequenceAllocatorRedis {
  /** Atomically increments a key by one and returns the new value. */
  incr(key: string): Promise<number>;
  /** Sets a key, optionally only when absent (`NX`) and/or with a TTL (`PX`). */
  set(
    key: string,
    value: string,
    opts?: { NX?: boolean; PX?: number },
  ): Promise<"OK" | null>;
  /** Reads a key. Expired keys resolve to `null`. */
  get(key: string): Promise<string | null>;
  /** Deletes a key, returning the number of keys removed. */
  del(key: string): Promise<number>;
  /** Runs a server-side script. */
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/** A sequence number handed out by the allocator. */
export interface SequenceReservation {
  /**
   * Opaque handle identifying this reservation. Pass it to
   * {@link SequenceAllocator.release} or {@link SequenceAllocator.commit}.
   */
  token: string;
  /** The reserved sequence number, as a decimal string. */
  sequence: string;
}

export interface SequenceAllocatorOptions {
  /** Redis client used to coordinate reservations across replicas. */
  redis: SequenceAllocatorRedis;
  /** Key prefix; every key the allocator touches starts with this value. */
  key: string;
  /** First sequence number handed out. */
  startSequence: string;
  /** How long a reservation is held before it may be reclaimed, in ms. */
  reservationTtlMs: number;
  /** Maximum number of candidate slots tried before giving up. Default 64. */
  maxAttempts?: number;
}

/**
 * Deletes a reservation key only when it still holds the expected owner.
 * Used so that a late rollback cannot delete a reservation that has since
 * been re-issued to another owner.
 */
const COMPARE_AND_DELETE_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

/** Separator between the slot and the owner inside a reservation token. */
const TOKEN_SEPARATOR = "|";

export class SequenceAllocator {
  private readonly redis: SequenceAllocatorRedis;
  private readonly key: string;
  private readonly startSequence: bigint;
  private readonly reservationTtlMs: number;
  private readonly maxAttempts: number;

  constructor(opts: SequenceAllocatorOptions) {
    this.redis = opts.redis;
    this.key = opts.key;
    this.startSequence = BigInt(opts.startSequence);
    this.reservationTtlMs = opts.reservationTtlMs;
    this.maxAttempts = opts.maxAttempts ?? 64;
  }

  /**
   * Reserves the next free sequence number for an account.
   *
   * The reservation is held for {@link SequenceAllocatorOptions.reservationTtlMs}
   * and must be released or committed by the caller. If the caller crashes,
   * {@link SequenceAllocator.rollbackExpired} reclaims the slot later.
   */
  async reserve(account: string = ""): Promise<SequenceReservation> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const slot = await this.redis.incr(this.seqKey);
      const sequence = this.sequenceForSlot(slot);

      // NX + PX makes the claim atomic: exactly one worker wins the slot and
      // the reservation disappears automatically if that worker never reports
      // back.
      const claimed = await this.redis.set(this.reservationKey(slot), account, {
        NX: true,
        PX: this.reservationTtlMs,
      });
      if (claimed !== "OK") {
        // Another worker holds this slot; move on to the next one.
        continue;
      }

      await this.redis.set(this.claimedKey(slot), "1");
      await this.redis.incr(this.reservedCountKey);

      return { token: this.makeToken(slot, account), sequence };
    }

    throw new Error(
      `Unable to reserve a sequence number: ${this.maxAttempts} candidate slots are already held`,
    );
  }

  /**
   * Releases a reservation so that its sequence number can be reused.
   *
   * Used when the reserved transaction was never submitted. Safe to call more
   * than once.
   */
  async release(token: string): Promise<void> {
    const parsed = this.parseToken(token);
    if (!parsed) return;

    const deleted = await this.redis.eval(
      COMPARE_AND_DELETE_SCRIPT,
      1,
      this.reservationKey(parsed.slot),
      parsed.account,
    );

    if (Number(deleted) > 0) {
      await this.redis.del(this.claimedKey(parsed.slot));
      await this.redis.incr(this.releasedCountKey);
    }
  }

  /**
   * Marks a reservation as consumed. The sequence number is retired and is
   * never handed out again.
   */
  async commit(token: string): Promise<void> {
    const parsed = this.parseToken(token);
    if (!parsed) return;

    const deleted = await this.redis.eval(
      COMPARE_AND_DELETE_SCRIPT,
      1,
      this.reservationKey(parsed.slot),
      parsed.account,
    );

    if (Number(deleted) > 0) {
      await this.redis.set(this.usedKey(parsed.slot), "1");
      await this.redis.del(this.claimedKey(parsed.slot));
      await this.redis.incr(this.releasedCountKey);
    }
  }

  /**
   * Releases the reservation held for a specific account and sequence number.
   *
   * This is the account-scoped counterpart of {@link SequenceAllocator.release}
   * and is used when a submission fails with `txBAD_SEQ`.
   */
  async rollback(account: string, sequence: string): Promise<void> {
    const slot = this.slotForSequence(sequence);
    if (slot === undefined) return;

    const deleted = await this.redis.eval(
      COMPARE_AND_DELETE_SCRIPT,
      1,
      this.reservationKey(slot),
      account,
    );

    if (Number(deleted) > 0) {
      await this.redis.del(this.claimedKey(slot));
      await this.redis.incr(this.releasedCountKey);
    }
  }

  /**
   * Number of reservations that are currently outstanding.
   *
   * A reservation stops counting as pending once it has been released,
   * committed or reclaimed by {@link SequenceAllocator.rollbackExpired}.
   */
  async pendingReservations(): Promise<number> {
    const [reserved, released] = await Promise.all([
      this.redis.get(this.reservedCountKey),
      this.redis.get(this.releasedCountKey),
    ]);

    const reservedCount = Number(reserved ?? "0");
    const releasedCount = Number(released ?? "0");
    return Math.max(0, reservedCount - releasedCount);
  }

  /**
   * Reclaims reservations whose TTL elapsed without being released or
   * committed (for example because the worker that held them crashed).
   *
   * Reclaimed sequence numbers are handed out again, so the allocator also
   * rewinds the slot counter when the highest allocated slot was reclaimed.
   */
  async rollbackExpired(): Promise<void> {
    const lastSlot = Number((await this.redis.get(this.seqKey)) ?? "0");
    if (!Number.isFinite(lastSlot) || lastSlot <= 0) return;

    let reclaimed = 0;
    let highestReclaimed = 0;

    for (let slot = 1; slot <= lastSlot; slot++) {
      // A committed slot is retired and must never be reused.
      if ((await this.redis.get(this.usedKey(slot))) === "1") continue;
      // A slot that was never reserved (or was already released) has no
      // pending claim.
      if ((await this.redis.get(this.claimedKey(slot))) !== "1") continue;
      // The reservation key is gone once its TTL elapsed.
      if ((await this.redis.get(this.reservationKey(slot))) !== null) continue;

      await this.redis.del(this.claimedKey(slot));
      await this.redis.incr(this.releasedCountKey);
      reclaimed += 1;
      if (slot > highestReclaimed) highestReclaimed = slot;
    }

    if (reclaimed === 0) return;

    // Rewind the counter so the freed slot is handed out again. Only the
    // highest slot may be rewound: rewinding past a slot that is still held
    // would hand out the same sequence number twice.
    if (highestReclaimed === lastSlot) {
      await this.redis.set(this.seqKey, String(lastSlot - 1));
    }
  }

  private sequenceForSlot(slot: number): string {
    return (this.startSequence + BigInt(slot - 1)).toString();
  }

  private slotForSequence(sequence: string): number | undefined {
    try {
      const value = BigInt(sequence);
      const slot = value - this.startSequence + BigInt(1);
      return slot > 0 ? Number(slot) : undefined;
    } catch {
      return undefined;
    }
  }

  private makeToken(slot: number, account: string): string {
    return `${slot}${TOKEN_SEPARATOR}${account}`;
  }

  private parseToken(token: string): { slot: number; account: string } | undefined {
    const index = token.indexOf(TOKEN_SEPARATOR);
    if (index < 0) return undefined;

    const slot = Number(token.slice(0, index));
    if (!Number.isInteger(slot) || slot <= 0) return undefined;

    return { slot, account: token.slice(index + 1) };
  }

  private get seqKey(): string {
    return `${this.key}:seq`;
  }

  private get reservedCountKey(): string {
    return `${this.key}:reserved`;
  }

  private get releasedCountKey(): string {
    return `${this.key}:released`;
  }

  private reservationKey(slot: number): string {
    return `${this.key}:res:${slot}`;
  }

  private claimedKey(slot: number): string {
    return `${this.key}:claimed:${slot}`;
  }

  private usedKey(slot: number): string {
    return `${this.key}:used:${slot}`;
  }
}
