# Social recovery HTTP contract

`useSocialRecovery` calls the recovery backend configured by `LumenClient.serverUrl`.
Recovery mutations use POST; only polling uses GET.

| Operation | Method and path | JSON body |
| --- | --- | --- |
| Initiate | `POST /recovery/initiate` | `{ walletId, newPublicKey }` |
| Approve | `POST /recovery/:id/approve` | `{ recoveryId }` |
| Cancel | `POST /recovery/:id/cancel` | None |
| Poll | `GET /recovery/:id` | None |

The hook URL-encodes recovery IDs in path segments. Each endpoint returns the
`RecoveryRequest` JSON shape exported by the hook. `LumenClient.post` uses the
same authentication headers and error handling as its other HTTP requests.

Backend integrations that previously accepted GET mutations must migrate those
handlers to POST and read initiation fields from the JSON body. GET requests
must not initiate, approve, or cancel recovery. Keep status polling read-only.

This repository's `packages/server` currently contains no `/recovery` routes or
recovery service; there are no corresponding server handlers to migrate here.
A deployed recovery backend must implement the contract above, including its
existing authentication, guardian authorization, and recovery persistence.
