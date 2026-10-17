/**
 * Fuzz Testing Harness for Transaction Building and Policy Checks
 *
 * This directory contains mutation and differential fuzz tests for the
 * Lumen core package. The harness uses `fast-check` to generate arbitrary
 * and malformed XDR envelopes, mutated Stellar operations, boundary
 * amounts, and unusual asset codes, then feeds them into the transaction
 * builder/parser and policy engine.
 *
 * Goals:
 *   - The parser must never throw unhandled panics. Only expected, typed
 *     errors are permitted.
 *   - The policy engine must always fail closed on malformed input.
 *
 * Test files:
 *   - `xdr.fuzz.test.ts`    — XDR envelope / operation / amount / asset fuzzing
 *                             against `buildTransaction` and `buildFeeBump`.
 *   - `policy.fuzz.test.ts` — Differential fuzzing of the policy engine to
 *                             ensure it fails closed on malformed input.
 *
 * Running the suite:
 *
 *   # Run all fuzz tests
 *   yarn jest packages/core/__tests__/fuzz
 *
 *   # Run a single fuzz file
 *   yarn jest packages/core/__tests__/fuzz/xdr.fuzz.test.ts
 *   yarn jest packages/core/__tests__/fuzz/policy.fuzz.test.ts
 *
 *   # Run with a custom seed for reproducibility
 *   FC_SEED=12345 yarn jest packages/core/__tests__/fuzz
 *
 * Each suite is configured with `numRuns: 25000` (25,000+ randomized
 * iterations) to satisfy the acceptance criteria for issue #309.
 *
 * @packageDocumentation
 */

export {};