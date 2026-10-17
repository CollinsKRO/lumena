# Policy Engine Configuration Spec

The Lumen `PolicyEngine` allows integrators to enforce rules on wallets before the co-signer service signs any transaction. This document describes the typescript interfaces, JSON schemas, and API payloads for configuring spend limits, transaction velocity, and destination allowlists.

---

## Table of Contents
1. [TypeScript Interfaces](#1-typescript-interfaces)
2. [JSON Schema](#2-json-schema)
3. [API Reference](#3-api-reference)
   - [POST /policy](#post-policy)
   - [GET /policy/:walletId](#get-policywalletid)
4. [Example Configurations](#4-example-configurations)
   - [Spend Limit Policy](#spend-limit-policy)
   - [USD Spend Limit Policy](#usd-spend-limit-policy)
   - [Velocity Check Policy](#velocity-check-policy)
   - [Allowlist Policy](#allowlist-policy)
   - [Combined Multi-Rule Policy](#combined-multi-rule-policy)

---

## 1. TypeScript Interfaces

The policy-related types are exported by the `@lumen/types` package:

```typescript
export interface Policy {
  id: string;          // Automatically generated UUID
  walletId: string;    // The public Stellar address of the user wallet
  rules: PolicyRule[]; // Array of active rules applied to this wallet
  createdAt: Date;     // Server creation timestamp
}

export type PolicyRule =
  | SpendLimit
  | UsdSpendLimit
  | VelocityRule
  | AllowlistRule
  | SessionKeyPolicyRule
  | TimeBoundsRule;

/**
 * Limits spend amounts for specific assets.
 */
export interface SpendLimit {
  type: "spend_limit";
  asset: string;       // "native" (for XLM) or a specific asset code
  maxPerTx: string;    // Decimal string representing max amount per transaction
  maxDaily: string;    // Decimal string representing max cumulative amount per day
}

/**
 * Limits spend amounts expressed in USD, using an on-chain oracle price feed
 * (e.g. Reflector/Band/Pyth or a mock Soroban oracle) to convert asset amounts
 * to their USD equivalent before authorizing a payment.
 *
 * The oracle consumer contract lives in `contracts/oracle-spend-limit/`.
 */
export interface UsdSpendLimit {
  type: "usd_spend_limit";
  asset: string;          // "native" (for XLM) or a specific asset code
  maxPerTxUsd: string;    // Decimal string, max USD value per transaction
  maxDailyUsd: string;    // Decimal string, max cumulative USD value per day
  oracle: OracleConfig;   // Price feed the consumer reads from
}

/**
 * Configuration for the oracle price feed consumed by the USD spend limit.
 */
export interface OracleConfig {
  contractId: string;     // Address of the oracle contract (e.g. Reflector)
  assetKey: string;       // Asset identifier the oracle prices (e.g. "XLM")
  maxPriceAgeSeconds: number; // Max acceptable age of a price before it is stale
}

/**
 * Prevents transaction spam or limits transaction frequency.
 */
export interface VelocityRule {
  type: "velocity";
  maxTransactions: number; // Max number of transactions permitted
  windowMinutes: number;   // Rolling window size in minutes
}

/**
 * Restricts outgoing payments only to pre-approved destinations.
 */
export interface AllowlistRule {
  type: "allowlist";
  destinations: string[]; // List of allowed destination Stellar G... public keys
}

export interface SessionKeyPolicyRule {
  type: "session_key";
  sessionPublicKey: string;
  maxSpend: string;
  expiresAt: number;
}

export interface TimeBoundsRule {
  type: "timebounds";
  maxWindowSeconds?: number;
  allowUnbounded?: boolean;
}
```

---

## 2. JSON Schema

Integrators can use the JSON schema below to validate payloads or autogenerate client models. This schema defines the structure for the `POST /policy` request body.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "CreatePolicyRequest",
  "type": "object",
  "required": ["walletId", "rules"],
  "properties": {
    "walletId": {
      "type": "string",
      "pattern": "^G[A-Z2-7]{55}$",
      "description": "The Stellar G-address representing the user's wallet."
    },
    "rules": {
      "type": "array",
      "minItems": 1,
      "items": {
        "$ref": "#/definitions/PolicyRule"
      },
      "description": "An array of rules to evaluate before co-signing a transaction."
    }
  },
  "definitions": {
    "PolicyRule": {
      "type": "object",
      "discriminator": {
        "propertyName": "type"
      },
      "oneOf": [
        {
          "title": "SpendLimit",
          "type": "object",
          "required": ["type", "asset", "maxPerTx", "maxDaily"],
          "properties": {
            "type": {
              "type": "string",
              "const": "spend_limit"
            },
            "asset": {
              "type": "string",
              "description": "Asset identifier. Use 'native' for XLM."
            },
            "maxPerTx": {
              "type": "string",
              "pattern": "^[0-9]+(?:\\.[0-9]+)?$",
              "description": "Maximum amount permitted in a single transaction (decimal string)."
            },
            "maxDaily": {
              "type": "string",
              "pattern": "^[0-9]+(?:\\.[0-9]+)?$",
              "description": "Maximum aggregate amount permitted within 24 hours (decimal string)."
            }
          }
        },
        {
          "title": "UsdSpendLimit",
          "type": "object",
          "required": ["type", "asset", "maxPerTxUsd", "maxDailyUsd", "oracle"],
          "properties": {
            "type": {
              "type": "string",
              "const": "usd_spend_limit"
            },
            "asset": {
              "type": "string",
              "description": "Asset identifier. Use 'native' for XLM."
            },
            "maxPerTxUsd": {
              "type": "string",
              "pattern": "^[0-9]+(?:\\.[0-9]+)?$",
              "description": "Maximum USD value permitted in a single transaction (decimal string)."
            },
            "maxDailyUsd": {
              "type": "string",
              "pattern": "^[0-9]+(?:\\.[0-9]+)?$",
              "description": "Maximum aggregate USD value permitted within 24 hours (decimal string)."
            },
            "oracle": {
              "type": "object",
              "required": ["contractId", "assetKey", "maxPriceAgeSeconds"],
              "properties": {
                "contractId": {
                  "type": "string",
                  "description": "Address of the oracle contract (e.g. Reflector)."
                },
                "assetKey": {
                  "type": "string",
                  "description": "Asset identifier the oracle prices (e.g. 'XLM')."
                },
                "maxPriceAgeSeconds": {
                  "type": "integer",
                  "minimum": 1,
                  "description": "Maximum acceptable age of a price before it is treated as stale."
                }
              }
            }
          }
        },
        {
          "title": "VelocityRule",
          "type": "object",
          "required": ["type", "maxTransactions", "windowMinutes"],
          "properties": {
            "type": {
              "type": "string",
              "const": "velocity"
            },
            "maxTransactions": {
              "type": "integer",
              "minimum": 1,
              "description": "Maximum number of transactions allowed in the window."
            },
            "windowMinutes": {
              "type": "integer",
              "minimum": 1,
              "description": "Rolling window size in minutes."
            }
          }
        },
        {
          "title": "AllowlistRule",
          "type": "object",
          "required": ["type", "destinations"],
          "properties": {
            "type": {
              "type": "string",
              "const": "allowlist"
            },
            "destinations": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^G[A-Z2-7]{55}$",
                "description": "Stellar public address (G...)."
              },
              "description": "Approved destination addresses."
            }
          }
        }
      ]
    }
  }
}
```

---

## 3. API Reference

### POST `/policy`

Registers or updates the co-signing policy rules associated with a wallet.

- **URL**: `/policy`
- **Method**: `POST`
- **Headers**:
  - `Content-Type: application/json`

#### Request Body
```json
{
  "walletId": "GB2X2Z5XQ7Y6F3T3C7F5N5YUXW2QZQXUYQ7C5W4F5A6S7D8F9G0H1J2K",
  "rules": [
    {
      "type": "spend_limit",
      "asset": "native",
      "maxPerTx": "100.0",
      "maxDaily": "500.0"
    }
  ]
}
```

#### Response (200 OK)
Returns the created policy containing the generated `id` and `createdAt` timestamp.
```json
{
  "id": "c1a2e3f4-5b6c-7d8e-9f0a-1b2c3d4e5f6a",
  "walletId": "GB2X2Z5XQ7Y6F3T3C7F5N5YUXW2QZQXUYQ7C5W4F5A6S7D8F9G0H1J2K",
  "rules": [
    {
      "type": "spend_limit",
      "asset": "native",
      "maxPerTx": "100.0",
      "maxDaily": "500.0"
    }
  ],
  "createdAt": "2026-07-16T13:40:00.000Z"
}
```

### GET `/policy/:walletId`

Retrieves the policy currently configured for the specified wallet.

- **URL**: `/policy/:walletId`
- **Method**: `GET`

#### Response (200 OK)
```json
{
  "id": "c1a2e3f4-5b6c-7d8e-9f0a-1b2c3d4e5f6a",
  "walletId": "GB2X2Z5XQ7Y6F3T3C7F5N5YUXW2QZQXUYQ7C5W4F5A6S7D8F9G0H1J2K",
  "rules": [
    {
      "type": "spend_limit",
      "asset": "native",
      "maxPerTx": "100.0",
      "maxDaily": "500.0"
    }
  ],
  "createdAt": "2026-07-16T13:40:00.000Z"
}
```

#### Response (404 Not Found)
Returned when no policy configuration exists for the provided `walletId`.
```json
{
  "error": "No policy found"
}
```

---

## 4. Example Configurations

### Spend Limit Policy

Limits user transactions to a maximum of 50 XLM per transaction, and an aggregate of 200 XLM per day.

#### Request Payload
```json
{
  "walletId": "GD3Y2Z5XQ7Y6F3T3C7F5N5YUXW2QZQXUYQ7C5W4F5A6S7D8F9G0H1J2K",
  "rules": [
    {
      "type": "spend_limit",
      "asset": "native",
      "maxPerTx": "50",
      "maxDaily": "200"
    }
  ]
}
```

### USD Spend Limit Policy

Limits spend by **USD value** rather than a static asset amount, so limits stay
stable when the fiat value of XLM fluctuates. The oracle consumer contract
(`contracts/oracle-spend-limit/`) reads the price feed, converts the payment
amount to USD using standard precision math, and compares the result against
`maxPerTxUsd` and `maxDailyUsd`.

- `oracle.contractId` — address of the price feed contract (e.g. Reflector).
- `oracle.assetKey` — the asset the oracle prices (e.g. `XLM`).
- `oracle.maxPriceAgeSeconds` — a price older than this is considered **stale**.

**Fail-safe behavior:** if the oracle price is stale (older than
`maxPriceAgeSeconds`) or missing (no price published for the asset), the rule
**fails closed** — the transaction is rejected and never co-signed. The consumer
does not fall back to a cached or default price.

#### Request Payload
```json
{
  "walletId": "GD3Y2Z5XQ7Y6F3T3C7F5N5YUXW2QZQXUYQ7C5W4F5A6S7D8F9G0H1J2K",
  "rules": [
    {
      "type": "usd_spend_limit",
      "asset": "native",
      "maxPerTxUsd": "25.00",
      "maxDailyUsd": "100.00",
      "oracle": {
        "contractId": "CBX2X2Z5XQ7Y6F3T3C7F5N5YUXW2QZQXUYQ7C5W4F5A6S7D8F9G0H1J2K",
        "assetKey": "XLM",
        "maxPriceAgeSeconds": 300
      }
    }
  ]
}
```

### Velocity Check Policy

Allows a maximum of 5 transactions every 60 minutes.

#### Request Payload
```json
{
  "walletId": "GD3Y2Z5XQ7Y6F3T3C7F5N5YUXW2QZQXUYQ7C5W4F5A6S7D8F9G0H1J2K",
  "rules": [
    {
      "type": "velocity",
      "maxTransactions": 5,
      "windowMinutes": 60
    }
  ]
}
```

### Allowlist Policy

Restricts outgoing payments to a specific set of safe addresses (e.g. withdrawal endpoints or internal storage).

#### Request Payload
```json
{
  "walletId": "GD3Y2Z5XQ7Y6F3T3C7F5N5YUXW2QZQXUYQ7C5W4F5A6S7D8F9G0H1J2K",
  "rules": [
    {
      "type": "allowlist",
      "destinations": [
        "GBL7F5N5YUXW2QZQXUYQ7C5W4F5A6S7D8F9G0H1J2KGD3Y2Z5XQ7Y6F3",
        "GC2X2Z5XQ7Y6F3T3C7F5N5YUXW2QZQXUYQ7C5W4F5A6S7D8F9G0H1J2K"
      ]
    }
  ]
}
```

### Combined Multi-Rule Policy

All rules in the array are evaluated sequentially. A transaction will only be co-signed if it passes **every** rule.

In the example below:
1. Max transaction size is 10 XLM, max daily is 50 XLM.
2. Max 3 transactions are allowed every 10 minutes.
3. Transactions can only send to the listed addresses.

#### Request Payload
```json
{
  "walletId": "GD3Y2Z5XQ7Y6F3T3C7F5N5YUXW2QZQXUYQ7C5W4F5A6S7D8F9G0H1J2K",
  "rules": [
    {
      "type": "spend_limit",
      "asset": "native",
      "maxPerTx": "10",
      "maxDaily": "50"
    },
    {
      "type": "velocity",
      "maxTransactions": 3,
      "windowMinutes": 10
    },
    {
      "type": "allowlist",
      "destinations": [
        "GC2X2Z5XQ7Y6F3T3C7F5N5YUXW2QZQXUYQ7C5W4F5A6S7D8F9G0H1J2K"
      ]
    }
  ]
}
```
