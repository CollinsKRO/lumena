import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PolicyEngine } from '../policy/engine.js';

describe('PolicyEngine property-based tests', () => {
  it('approving a transaction always updates the spend tracker', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 86_400 }),
        (spendAmount, dailyLimit, velocityWindowSeconds) => {
          const engine = new PolicyEngine({
            dailyLimit,
            velocityWindowSeconds,
          });

          const before = engine.getSpendTracker().totalSpent;
          const result = engine.evaluate({
            amount: spendAmount,
            timestamp: Date.now(),
          });

          if (result.approved) {
            const after = engine.getSpendTracker().totalSpent;
            expect(after).toBe(before + spendAmount);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('rejecting a transaction never updates the spend tracker', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 86_400 }),
        (spendAmount, dailyLimit, velocityWindowSeconds) => {
          const engine = new PolicyEngine({
            dailyLimit,
            velocityWindowSeconds,
          });

          const before = engine.getSpendTracker().totalSpent;
          const result = engine.evaluate({
            amount: spendAmount,
            timestamp: Date.now(),
          });

          if (!result.approved) {
            const after = engine.getSpendTracker().totalSpent;
            expect(after).toBe(before);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
