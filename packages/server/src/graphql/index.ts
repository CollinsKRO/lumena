import type { Request, Response } from "express";
import { createSchema, createYoga, Repeater } from "graphql-yoga";
import { GraphQLError, GraphQLScalarType, Kind, type ValueNode } from "graphql";
import { StrKey, type Horizon } from "@stellar/stellar-sdk";
import type { StellarClient } from "@lumen/core";
import type { Policy } from "@lumen/types";
import type { PolicyEngine } from "../policy/engine.js";
import { cosignRequestsTotal, feeBumpRequestsTotal } from "../metrics.js";

export interface GraphQLGatewayOpts {
  client: StellarClient;
  policyEngine: PolicyEngine;
}

type TransactionRecord = Horizon.ServerApi.TransactionRecord;

export const typeDefs = /* GraphQL */ `
  scalar JSON

  type Balance {
    assetType: String!
    assetCode: String
    assetIssuer: String
    balance: String!
  }

  type Transaction {
    id: ID!
    hash: String!
    ledger: Int!
    createdAt: String!
    sourceAccount: String!
    feeCharged: String!
    operationCount: Int!
    successful: Boolean!
    memo: String
    pagingToken: String!
  }

  type Policy {
    id: ID!
    walletId: String!
    rules: [JSON!]!
    createdAt: String!
  }

  type Wallet {
    address: String!
    balances: [Balance!]!
    policy: Policy
    transactions(limit: Int = 20, cursor: String): [Transaction!]!
  }

  type Metrics {
    cosignApproved: Float!
    cosignRejected: Float!
    feeBumpRequests: Float!
  }

  type Query {
    wallet(address: String!): Wallet!
    policy(walletId: String!): Policy
    policies: [Policy!]!
    metrics: Metrics!
  }

  type Subscription {
    transactionAdded(address: String!): Transaction!
  }
`;

function assertAddress(address: string): void {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new GraphQLError("address must be a valid Stellar public key", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
}

function toTransaction(record: TransactionRecord) {
  return {
    id: record.id,
    hash: record.hash,
    ledger: record.ledger_attr,
    createdAt: record.created_at,
    sourceAccount: record.source_account,
    feeCharged: String(record.fee_charged),
    operationCount: record.operation_count,
    successful: record.successful,
    memo: record.memo ?? null,
    pagingToken: record.paging_token,
  };
}

function toPolicy(policy: Policy) {
  return {
    ...policy,
    createdAt: new Date(policy.createdAt).toISOString(),
  };
}

function parseLiteral(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.OBJECT:
      return Object.fromEntries(
        ast.fields.map((field) => [field.name.value, parseLiteral(field.value)]),
      );
    case Kind.LIST:
      return ast.values.map(parseLiteral);
    default:
      return null;
  }
}

const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description: "Arbitrary JSON value",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral,
});

async function counterValue(
  counter: typeof cosignRequestsTotal | typeof feeBumpRequestsTotal,
  labels: Record<string, string> = {},
): Promise<number> {
  const { values } = await counter.get();
  const match = values.find((v) =>
    Object.entries(labels).every(([key, value]) => v.labels[key] === value),
  );
  return match?.value ?? 0;
}

/** Creates the GraphQL gateway served alongside the existing REST endpoints. */
export function createGraphQLGateway(opts: GraphQLGatewayOpts) {
  const { client, policyEngine } = opts;

  const schema = createSchema({
    typeDefs,
    resolvers: {
      JSON: JSONScalar,
      Query: {
        wallet: (_parent: unknown, args: { address: string }) => {
          assertAddress(args.address);
          return { address: args.address };
        },
        policy: (_parent: unknown, args: { walletId: string }) => {
          const policy = policyEngine.getPolicy(args.walletId);
          return policy ? toPolicy(policy) : null;
        },
        policies: () => policyEngine.listPolicies().map(toPolicy),
        metrics: async () => ({
          cosignApproved: await counterValue(cosignRequestsTotal, { status: "approved" }),
          cosignRejected: await counterValue(cosignRequestsTotal, { status: "rejected" }),
          feeBumpRequests: await counterValue(feeBumpRequestsTotal),
        }),
      },
      Wallet: {
        balances: async (wallet: { address: string }) => {
          const account = await client.horizon.loadAccount(wallet.address);
          return account.balances.map((balance) => ({
            assetType: balance.asset_type,
            assetCode: "asset_code" in balance ? balance.asset_code : null,
            assetIssuer: "asset_issuer" in balance ? balance.asset_issuer : null,
            balance: balance.balance,
          }));
        },
        policy: (wallet: { address: string }) => {
          const policy = policyEngine.getPolicy(wallet.address);
          return policy ? toPolicy(policy) : null;
        },
        transactions: async (
          wallet: { address: string },
          args: { limit: number; cursor?: string | null },
        ) => {
          if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200) {
            throw new GraphQLError("limit must be an integer between 1 and 200", {
              extensions: { code: "BAD_USER_INPUT" },
            });
          }

          let builder = client.horizon
            .transactions()
            .forAccount(wallet.address)
            .order("desc")
            .limit(args.limit);
          if (args.cursor) {
            builder = builder.cursor(args.cursor);
          }
          const page = await builder.call();
          return page.records.map(toTransaction);
        },
      },
      Subscription: {
        transactionAdded: {
          subscribe: (_parent: unknown, args: { address: string }) => {
            assertAddress(args.address);
            return new Repeater<TransactionRecord>(async (push, stop) => {
              const close = client.horizon
                .transactions()
                .forAccount(args.address)
                .cursor("now")
                .stream({
                  onmessage: (record) => {
                    void push(record as unknown as TransactionRecord);
                  },
                  onerror: () => {
                    stop(new Error("Transaction stream disconnected"));
                  },
                });
              await stop;
              close();
            });
          },
          resolve: (record: TransactionRecord) => toTransaction(record),
        },
      },
    },
  });

  return createYoga<{ req: Request; res: Response }>({
    schema,
    graphqlEndpoint: "/graphql",
  });
}
