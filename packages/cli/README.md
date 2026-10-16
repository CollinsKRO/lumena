# `@lumen/cli`

Command-Line Interface (CLI) tool for inspecting wallets, managing policy specs, monitoring sponsor balances, and decoding transactions in the Lumen ecosystem.

## Installation

```bash
# Executable directly via npx
npx @lumen/cli --help
```

## Global Options

### `--json`

Output machine-readable JSON instead of human-readable text. Available for all commands.

```bash
# Get status as JSON
npx @lumen/cli status --json

# Get policy as JSON
npx @lumen/cli policy get G... --json

# Create wallet and output JSON
npx @lumen/cli wallet create --json

# Inspect transaction XDR as JSON
npx @lumen/cli cosign inspect "AAAAAgAAA..." --json
```

On error with `--json`, the CLI outputs `{ "error": "error message" }` to stderr and exits with a non-zero code.

## Commands Reference

### 1. `lumen status`
Checks the health of the Lumen server and the fee-sponsor account balance.

```bash
npx @lumen/cli status --server http://localhost:3000
```

### 2. `lumen policy get <walletId>`
Retrieves and displays the active policy rules for the specified wallet ID.

```bash
npx @lumen/cli policy get G...
```

### 3. `lumen policy set <file.json>`
Applies policy rules defined in a JSON file to a wallet.

```bash
npx @lumen/cli policy set ./policy-spec.json
```

### 4. `lumen policy delete <walletId>`
Removes the policy for the specified wallet ID.

```bash
npx @lumen/cli policy delete G...
```

### 5. `lumen wallet create`
Triggers creation of a new test sponsored wallet on the server.

```bash
npx @lumen/cli wallet create
```

### 6. `lumen wallet balance <address>`
Queries Horizon for all asset balances held by the specified address. Defaults to Stellar Testnet; use `--network` to select `mainnet` or `local`, or `--horizon-url` to provide a custom Horizon URL.

```bash
npx @lumen/cli wallet balance G... --network testnet
```

### 7. `lumen wallet export --id <walletId> --out <file.json>`
Exports a wallet as a password-protected, encrypted keystore file for backup or migration between machines.

```bash
npx @lumen/cli wallet export --id G... --out ./wallet-keystore.json
```

The command prompts interactively for a strong password (input is hidden). The password is never written to disk or passed on the command line.

#### Encrypted Keystore Format

The exported file is a standard JSON keystore containing:

- `version`: keystore format version.
- `id`: the exported wallet ID.
- `crypto.kdf`: `argon2id`, with a randomly generated `salt` and tuning parameters (`memoryCost`, `timeCost`, `parallelism`).
- `crypto.cipher`: `aes-256-gcm`, with a random `iv`, the `ciphertext`, and the GCM authentication `tag`.

The wallet secret is encrypted with AES-256-GCM using a key derived from your password via Argon2id. Because GCM is authenticated, any tampering with the file causes decryption to fail.

#### Importing on a Secondary Machine

Copy the exported keystore file to the target machine and import it with the same password:

```bash
npx @lumen/cli wallet import --in ./wallet-keystore.json
```

You will be prompted for the password used during export. On success, the wallet is restored and ready for use. Keep the keystore file and password secure; anyone with both can recover the wallet secret.

### 7. `lumen cosign inspect <xdr>`
Decodes transaction XDR, displays operation details, and simulates policy checks.

```bash
npx @lumen/cli cosign inspect "AAAAAgAAA..."
```

### 8. `lumen cosign submit <xdr> <walletAddress>`
Submits a signed transaction XDR to the server's `/cosign` endpoint for policy validation and co-signing.

```bash
npx @lumen/cli cosign submit "AAAAAgAAA..." G...
```

### 9. `lumen webhook create <file.json>`
Registers a webhook using a JSON configuration file containing `url`, `secret`, and `events`, with optional `id` and `enabled` fields.

```bash
npx @lumen/cli webhook create ./webhook.json
```

### 10. `lumen webhook list`
Lists registered webhooks. The server omits webhook secrets from this response.

```bash
npx @lumen/cli webhook list
```

### 11. `lumen webhook delete <id>`
Unregisters the webhook with the specified ID.

```bash
npx @lumen/cli webhook delete webhook-id
```

### 12. `lumen webhook deliveries`
Lists webhook delivery history.

```bash
npx @lumen/cli webhook deliveries
```

All webhook commands accept `--server <url>` to override the configured Lumen server URL and `--json` for machine-readable output.

---

## Development

You can run and develop `@lumen/cli` in isolation without running the entire monorepo.

### Prerequisites

1. **Install Dependencies**: Install dependencies from the repository root:
   ```bash
   pnpm install
   ```

2. **Build Dependent Packages**: Build the monorepo dependencies (`@lumen/core` and `@lumen/types`):
   ```bash
   pnpm build
   ```

3. **(Optional) Start Server & Network**: To run commands communicating with the backend (`status`, `wallet create`, `policy`):
   ```bash
   # Start local Stellar standalone container
   docker compose -f docker/docker-compose.yml up -d stellar

   # Start the Lumen server
   pnpm --filter @lumen/server dev
   ```

### Running in Development Mode

Run TypeScript in watch mode to automatically compile `src/` to `dist/` on changes:

```bash
pnpm --filter @lumen/cli dev
```

### Running the Local CLI Binary

Test commands with your local build:

```bash
node packages/cli/bin/lumen.js --help
node packages/cli/bin/lumen.js status --server http://localhost:3000
```

### Additional Package Scripts

From the repository root:

```bash
# Typecheck TypeScript files
pnpm --filter @lumen/cli typecheck

# Lint source files
pnpm --filter @lumen/cli lint

# Build CLI package
pnpm --filter @lumen/cli build

# Clean build artifacts
pnpm --filter @lumen/cli clean
```

---

## License

MIT
