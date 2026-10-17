import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import {
  ContractClient,
  Networks,
  SorobanRpc,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
  Address,
} from '@stellar/stellar-sdk';

/**
 * Options shared across `lumen contract` subcommands.
 */
export interface ContractCommandOptions {
  /** Soroban RPC server URL. */
  server?: string;
  /** Named network (e.g. `testnet`, `mainnet`, `futurenet`). */
  network?: string;
  /** Secret key used to sign the deployment / invocation transaction. */
  secret?: string;
  /** Emit machine-readable JSON instead of human-friendly output. */
  json?: boolean;
}

/**
 * Options specific to `lumen contract invoke`.
 */
export interface ContractInvokeOptions extends ContractCommandOptions {
  /** Repeated `--args` values, converted to ScVal via type inference. */
  args?: string[];
}

const DEFAULT_NETWORK = 'testnet';

/**
 * Resolve the Soroban RPC server URL from explicit options, falling back to
 * the well-known URL for the selected network.
 */
function resolveServerUrl(options: ContractCommandOptions): string {
  if (options.server) {
    return options.server;
  }

  const network = (options.network || DEFAULT_NETWORK).toLowerCase();
  const known = (Networks as Record<string, string>)[network.toUpperCase()];
  if (known) {
    return known;
  }

  // Fall back to the public testnet RPC endpoint when the network name is
  // unknown but no explicit server was provided.
  return Networks.FUTURENET || 'https://soroban-testnet.stellar.org';
}

/**
 * Build a Soroban RPC server instance for the given options.
 */
function createServer(options: ContractCommandOptions): SorobanRpc.Server {
  return new SorobanRpc.Server(resolveServerUrl(options), {
    allowHttp: resolveServerUrl(options).startsWith('http://'),
  });
}

/**
 * Resolve the signing keypair from `--secret` or the `SOROBAN_SECRET_KEY`
 * environment variable.
 */
function resolveKeypair(options: ContractCommandOptions): Keypair {
  const secret = options.secret || process.env.SOROBAN_SECRET_KEY;
  if (!secret) {
    throw new Error(
      'A signing key is required. Pass --secret <key> or set SOROBAN_SECRET_KEY.',
    );
  }
  return Keypair.fromSecret(secret);
}

/**
 * Attempt to infer the most appropriate ScVal for a raw CLI argument string.
 *
 * Inference order:
 *   1. `true` / `false`            -> boolean
 *   2. `null`                      -> void
 *   3. Numeric strings             -> i128 (or u32 when small & non-negative)
 *   4. Stellar account (G...) / contract (C...) addresses -> address
 *   5. Anything else               -> string
 */
export function inferScVal(raw: string): xdr.ScVal {
  const value = raw.trim();

  if (value === 'true' || value === 'false') {
    return nativeToScVal(value === 'true', { type: 'bool' });
  }

  if (value === 'null' || value === 'void') {
    return xdr.ScVal.scvVoid();
  }

  // Addresses: account (G...) or contract (C...).
  if (/^[GC][A-Z2-7]{55}$/.test(value)) {
    return new Address(value).toScVal();
  }

  // Integers.
  if (/^-?\d+$/.test(value)) {
    const asNumber = Number(value);
    if (Number.isSafeInteger(asNumber) && asNumber >= 0 && asNumber <= 0xffffffff) {
      return nativeToScVal(asNumber, { type: 'u32' });
    }
    return nativeToScVal(BigInt(value), { type: 'i128' });
  }

  // Floating point numbers.
  if (/^-?\d+\.\d+$/.test(value)) {
    return nativeToScVal(value, { type: 'string' });
  }

  // JSON arrays / objects are passed through as strings to avoid surprising
  // structural conversions; callers can pre-encode complex values.
  return nativeToScVal(value, { type: 'string' });
}

/**
 * Convert a list of raw CLI argument strings into ScVals.
 */
export function parseArgs(rawArgs: string[] | undefined): xdr.ScVal[] {
  if (!rawArgs || rawArgs.length === 0) {
    return [];
  }
  return rawArgs.map(inferScVal);
}

/**
 * Read the WASM bytecode from disk, validating the file exists and is a
 * plausible WASM module.
 */
export function readWasm(filePath: string): Buffer {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`WASM file not found: ${resolved}`);
  }

  const bytes = fs.readFileSync(resolved);
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61) {
    throw new Error(`File does not appear to be a valid WASM module: ${resolved}`);
  }

  return bytes;
}

/**
 * Deploy a WASM contract and return its contract ID.
 */
export async function deployContract(
  wasmPath: string,
  options: ContractCommandOptions = {},
): Promise<string> {
  const server = createServer(options);
  const keypair = resolveKeypair(options);
  const wasm = readWasm(wasmPath);

  const account = await server.getAccount(keypair.publicKey());

  const uploadTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: resolveNetworkPassphrase(options),
  })
    .addOperation(
      // Upload the WASM blob to the network.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import('@stellar/stellar-sdk')).Operation.uploadContractWasm({
        wasm,
      }),
    )
    .setTimeout(60)
    .build();

  const preparedUpload = await server.prepareTransaction(uploadTx);
  preparedUpload.sign(keypair);

  const uploadResponse = await server.sendTransaction(preparedUpload);
  const uploadResult = await pollTransaction(server, uploadResponse.hash);

  const wasmHash = extractWasmHash(uploadResult);

  // Create the contract instance from the uploaded WASM hash.
  const createAccount = await server.getAccount(keypair.publicKey());
  const createTx = new TransactionBuilder(createAccount, {
    fee: BASE_FEE,
    networkPassphrase: resolveNetworkPassphrase(options),
  })
    .addOperation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import('@stellar/stellar-sdk')).Operation.createCustomContract({
        address: Address.fromString(keypair.publicKey()),
        wasmHash,
      }),
    )
    .setTimeout(60)
    .build();

  const preparedCreate = await server.prepareTransaction(createTx);
  preparedCreate.sign(keypair);

  const createResponse = await server.sendTransaction(preparedCreate);
  const createResult = await pollTransaction(server, createResponse.hash);

  return extractContractId(createResult);
}

/**
 * Invoke a contract method and return the decoded native result.
 */
export async function invokeContract(
  contractId: string,
  method: string,
  options: ContractInvokeOptions = {},
): Promise<unknown> {
  const server = createServer(options);
  const keypair = resolveKeypair(options);
  const scArgs = parseArgs(options.args);

  const contract = new ContractClient(contractId, {
    networkPassphrase: resolveNetworkPassphrase(options),
    rpcUrl: resolveServerUrl(options),
    publicKey: keypair.publicKey(),
    signTransaction: async (tx: string) => {
      const parsed = TransactionBuilder.fromXDR(tx, resolveNetworkPassphrase(options));
      parsed.sign(keypair);
      return { signedTxXdr: parsed.toXDR(), signerAddress: keypair.publicKey() };
    },
  });

  const result = await contract.call(method, ...scArgs);
  return scValToNative(result as xdr.ScVal);
}

/**
 * Resolve the network passphrase for the configured network.
 */
function resolveNetworkPassphrase(options: ContractCommandOptions): string {
  const network = (options.network || DEFAULT_NETWORK).toLowerCase();
  switch (network) {
    case 'mainnet':
    case 'public':
      return Networks.PUBLIC;
    case 'futurenet':
      return Networks.FUTURENET;
    case 'testnet':
    case 'sandbox':
    default:
      return Networks.TESTNET;
  }
}

/**
 * Poll the RPC server until a submitted transaction reaches a terminal state.
 */
async function pollTransaction(
  server: SorobanRpc.Server,
  hash: string,
): Promise<SorobanRpc.Api.GetTransactionResponse> {
  const deadline = Date.now() + 60_000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await server.getTransaction(hash);
    if (response.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (response.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction failed: ${hash}`);
      }
      return response;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for transaction: ${hash}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * Extract the WASM hash from an upload transaction result.
 */
function extractWasmHash(
  response: SorobanRpc.Api.GetTransactionResponse,
): Buffer {
  const meta = (response as SorobanRpc.Api.GetSuccessfulTransactionResponse)
    .resultMetaXdr;
  if (!meta) {
    throw new Error('Missing transaction metadata for WASM upload.');
  }

  const parsed = xdr.TransactionMeta.fromXDR(meta, 'base64');
  const operations = parsed.v3().operations();
  for (const op of operations) {
    const changes = op.changes();
    for (const change of changes) {
      if (change.switch() === xdr.LedgerEntryChangeType.ledgerEntryCreated()) {
        const entry = change.created();
        const data = entry.data();
        if (data.switch() === xdr.LedgerEntryType.contractCode()) {
          return Buffer.from(data.contractCode().hash());
        }
      }
    }
  }

  throw new Error('Unable to determine WASM hash from transaction result.');
}

/**
 * Extract the created contract ID from a create-contract transaction result.
 */
function extractContractId(
  response: SorobanRpc.Api.GetTransactionResponse,
): string {
  const meta = (response as SorobanRpc.Api.GetSuccessfulTransactionResponse)
    .resultMetaXdr;
  if (!meta) {
    throw new Error('Missing transaction metadata for contract creation.');
  }

  const parsed = xdr.TransactionMeta.fromXDR(meta, 'base64');
  const operations = parsed.v3().operations();
  for (const op of operations) {
    const changes = op.changes();
    for (const change of changes) {
      if (change.switch() === xdr.LedgerEntryChangeType.ledgerEntryCreated()) {
        const entry = change.created();
        const data = entry.data();
        if (data.switch() === xdr.LedgerEntryType.contractData()) {
          const contract = data.contractData().contract();
          return Address.fromScAddress(contract).toString();
        }
      }
    }
  }

  throw new Error('Unable to determine contract ID from transaction result.');
}

/**
 * Format output for the CLI, honouring the `--json` flag.
 */
function emit(payload: unknown, options: ContractCommandOptions): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (typeof payload === 'string') {
    process.stdout.write(`${payload}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Register the `lumen contract` command (and its subcommands) on the given
 * Commander program.
 */
export function registerContractCommand(program: Command): Command {
  const contract = program
    .command('contract')
    .description('Deploy and invoke Soroban smart contracts');

  contract
    .command('deploy <wasmPath>')
    .description('Deploy a WASM contract and print its contract ID')
    .option('--server <url>', 'Soroban RPC server URL')
    .option('--network <name>', 'Target network (testnet, futurenet, mainnet)')
    .option('--secret <key>', 'Secret key used to sign the deployment')
    .option('--json', 'Emit machine-readable JSON output')
    .action(async (wasmPath: string, options: ContractCommandOptions) => {
      try {
        const contractId = await deployContract(wasmPath, options);
        emit({ contractId }, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.json) {
          emit({ error: message }, options);
        } else {
          process.stderr.write(`Error: ${message}\n`);
        }
        process.exitCode = 1;
      }
    });

  contract
    .command('invoke <contractId> <method>')
    .description('Invoke a contract method with automatic argument conversion')
    .option('--server <url>', 'Soroban RPC server URL')
    .option('--network <name>', 'Target network (testnet, futurenet, mainnet)')
    .option('--secret <key>', 'Secret key used to sign the invocation')
    .option(
      '--args <value...>',
      'Arguments to pass to the contract method (repeatable)',
    )
    .option('--json', 'Emit machine-readable JSON output')
    .action(
      async (
        contractId: string,
        method: string,
        options: ContractInvokeOptions,
      ) => {
        try {
          const result = await invokeContract(contractId, method, options);
          emit({ result }, options);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (options.json) {
            emit({ error: message }, options);
          } else {
            process.stderr.write(`Error: ${message}\n`);
          }
          process.exitCode = 1;
        }
      },
    );

  return contract;
}

export default registerContractCommand;