# Lumen Contract Event Schema

Every Lumen Soroban contract publishes events through `event_schema::publish`, so
off-chain subscribers can filter and decode them without per-contract logic.

## Topics

Each event carries exactly three topics, in this order:

| Index | Name       | ScVal type   | Description                                  |
| ----- | ---------- | ------------ | -------------------------------------------- |
| 0     | `contract` | `ScvSymbol`  | Emitting contract, in `snake_case`           |
| 1     | `action`   | `ScvSymbol`  | Action that happened, in `snake_case`        |
| 2     | `wallet`   | `ScvAddress` | Wallet (account or contract) the event concerns |

Subscribers can filter on `contract` and `action` with Soroban RPC `getEvents`
topic filters (e.g. `["smart_account", "transfer", "*"]`), or narrow to a single
wallet by setting the third segment. Rust consumers can decode raw topics with
`EventTopics::parse`, which returns `None` for any event that does not follow
this layout.

## Payload schemas

| Contract        | Action     | Wallet topic        | Payload (`ScVal`)                                                  |
| --------------- | ---------- | ------------------- | ------------------------------------------------------------------ |
| `smart_account` | `transfer` | Smart account       | `ScvVec[token: ScvAddress, to: ScvAddress, amount: ScvI128]`       |
