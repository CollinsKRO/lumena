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

/**
 * Options for the policy-guard registry helpers (`#222`).
 */
export interface PolicyGuardOptions extends ContractCommandOptions {
  /** Contract ID to register / verify / validate. */
  target?: string;
  /** Hex-encoded WASM hash of the target contract. */
  wasmHash?: string;
  /** Comma-separated list of call targets to validate. */
  targets?: string;
}

/**
 * Options for the oracle spend-limit helper (`#223`).
 */
export interface OracleSpendLimitOptions extends ContractCommandOptions {
  /** Asset contract ID (or `native` for XLM). */
  asset?: string;
  /** Raw asset amount (in stroops / base units). */
  amount?: string;
  /** Spend limit expressed in USD (7-decimal fixed point). */
  limit?: string;
}

/**
 * Options for the upgradeable proxy helpers (`#224`).
 */
export interface ProxyOptions extends ContractCommandOptions {
  /** Hex-encoded WASM hash of the new implementation. */
  wasmHash?: string;
  /** Proposal ID for approve / execute. */
  proposalId?: string;
}

/**
 * Options for the inheritance vault helpers (`#225`).
 */
export interface InheritanceOptions extends ContractCommandOptions {
  /** Beneficiary account address. */
  beneficiary?: string;
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
 * Register a contract in the policy-guard verified registry (`#222`).
 */
export async function policyGuardRegister(
  contractId: string,
  options: PolicyGuardOptions = {},
): Promise<unknown> {
  if (!options.target) {
    throw new Error('A target contract ID is required. Pass --target <contractId>.');
  }
  if (!options.wasmHash) {
    throw new Error('A WASM hash is required. Pass --wasm-hash <hex>.');
  }
  return invokeContract(contractId, 'register', {
    ...options,
    args: [options.target, options.wasmHash],
  });
}

/**
 * Verify a contract against the policy-guard registry (`#222`).
 */
export async function policyGuardVerify(
  contractId: string,
  options: PolicyGuardOptions = {},
): Promise<unknown> {
  if (!options.target) {
    throw new Error('A target contract ID is required. Pass --target <contractId>.');
  }
  return invokeContract(contractId, 'verify', {
    ...options,
    args: [options.target],
  });
}

/**
 * Validate a batch of call targets against the policy-guard registry (`#222`).
 */
export async function policyGuardValidate(
  contractId: string,
  options: PolicyGuardOptions = {},
): Promise<unknown> {
  const targets = (options.targets || options.target || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (targets.length === 0) {
    throw new Error('At least one target is required. Pass --targets <id,id>.');
  }
  return invokeContract(contractId, 'validate', {
    ...options,
    args: targets,
  });
}

/**
 * Check a spend against the oracle-backed USD limit (`#223`).
 */
export async function oracleCheckSpend(
  contractId: string,
  options: OracleSpendLimitOptions = {},
): Promise<unknown> {
  if (!options.asset) {
    throw new Error('An asset is required. Pass --asset <contractId|native>.');
  }
  if (!options.amount) {
    throw new Error('An amount is required. Pass --amount <value>.');
  }
  if (!options.limit) {
    throw new Error('A USD limit is required. Pass --limit <usd>.');
  }
  return invokeContract(contractId, 'check_spend', {
    ...options,
    args: [options.asset, options.amount, options.limit],
  });
}

/**
 * Propose a proxy upgrade behind the timelock (`#224`).
 */
export async function proxyProposeUpgrade(
  contractId: string,
  options: ProxyOptions = {},
): Promise<unknown> {
  if (!options.wasmHash) {
    throw new Error('A WASM hash is required. Pass --wasm-hash <hex>.');
  }
  return invokeContract(contractId, 'propose_upgrade', {
    ...options,
    args: [options.wasmHash],
  });
}

/**
 * Approve a pending proxy upgrade proposal (`#224`).
 */
export async function proxyApproveUpgrade(
  contractId: string,
  options: ProxyOptions = {},
): Promise<unknown> {
  if (!options.proposalId) {
    throw new Error('A proposal ID is required. Pass --proposal-id <id>.');
  }
  return invokeContract(contractId, 'approve_upgrade', {
    ...options,
    args: [options.proposalId],
  });
}

/**
 * Execute a timelocked proxy upgrade (`#224`).
 */
export async function proxyExecuteUpgrade(
  contractId: string,
  options: ProxyOptions = {},
): Promise<unknown> {
  if (!options.proposalId) {
    throw new Error('A proposal ID is required. Pass --proposal-id <id>.');
  }
  return invokeContract(contractId, 'execute_upgrade', {
    ...options,
    args: [options.proposalId],
  });
}

/**
 * Record a heartbeat on the inheritance vault (`#225`).
 */
export async function inheritanceHeartbeat(
  contractId: string,
  options: InheritanceOptions = {},
): Promise<unknown> {
  return invokeContract(contractId, 'heartbeat', { ...options, args: [] });
}

/**
 * Claim custody from the inheritance vault once dormant (`#225`).
 */
export async function inheritanceClaim(
  contractId: string,
  options: InheritanceOptions = {},
): Promise<unknown> {
  if (!options.beneficiary) {
    throw new Error('A beneficiary is required. Pass --beneficiary <address>.');
  }
  return invokeContract(contractId, 'claim', {
    ...options,
    args: [options.beneficiary],
  });
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

  contract
    .command('policy-guard-register <contractId>')
    .description('Register a verified contract in the policy-guard registry (#222)')
    .option('--target <contractId>', 'Contract ID to register')
    .option('--wasm-hash <hex>', 'Hex-encoded WASM hash of the target')
    .option('--server <url>', 'Soroban RPC server URL')
    .option('--network <name>', 'Target network (testnet, futurenet, mainnet)')
    .option('--secret <key>', 'Secret key used to sign the invocation')
    .option('--json', 'Emit machine-readable JSON output')
    .action(async (contractId: string, options: PolicyGuardOptions) => {
      try {
        const result = await policyGuardRegister(contractId, options);
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
    });

  contract
    .command('policy-guard-verify <contractId>')
    .description('Verify a contract against the policy-guard registry (#222)')
    .option('--target <contractId>', 'Contract ID to verify')
    .option('--server <url>', 'Soroban RPC server URL')
    .option('--network <name>', 'Target network (testnet, futurenet, mainnet)')
    .option('--secret <key>', 'Secret key used to sign the invocation')
    .option('--json', 'Emit machine-readable JSON output')
    .action(async (contractId: string, options: PolicyGuardOptions) => {
      try {
        const result = await policyGuardVerify(contractId, options);
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
    });

  contract
    .command('policy-guard-validate <contractId>')
    .description('Validate call targets against the policy-guard registry (#222)')
    .option('--targets <ids>', 'Comma-separated list of call targets')
    .option('--target <contractId>', 'Single call target')
    .option('--server <url>', 'Soroban RPC server URL')
    .option('--network <name>', 'Target network (testnet, futurenet, mainnet)')
    .option('--secret <key>', 'Secret key used to sign the invocation')
    .option('--json', 'Emit machine-readable JSON output')
    .action(async (contractId: string, options: PolicyGuardOptions) => {
      try {
        const result = await policyGuardValidate(contractId, options);
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
    });

  contract
    .command('oracle-check-spend <contractId>')
    .description('Check a spend against the oracle USD limit (#223)')
    .option('--asset <id>', 'Asset contract ID or "native" for XLM')
    .option('--amount <value>', 'Raw asset amount in base units')
    .option('--limit <usd>', 'USD spend limit (7-decimal fixed point)')
    .option('--server <url>', 'Soroban RPC server URL')
    .option('--network <name>', 'Target network (testnet, futurenet, mainnet)')
    .option('--secret <key>', 'Secret key used to sign the invocation')
    .option('--json', 'Emit machine-readable JSON output')
    .action(async (contractId: string, options: OracleSpendLimitOptions) => {
      try {
        const result = await oracleCheckSpend(contractId, options);
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
    });

  contract
    .command('proxy-propose-upgrade <contractId>')
    .description('Propose a timelocked proxy upgrade (#224)')
    .option('--wasm-hash <hex>', 'Hex-encoded WASM hash of the new implementation')
    .option('--server <url>', 'Soroban RPC server URL')
    .option('--network <name>', 'Target network (testnet, futurenet, mainnet)')
    .option('--secret <key>', 'Secret key used to sign the invocation')
    .option('--json', 'Emit machine-readable JSON output')
    .action(async (contractId: string, options: ProxyOptions) => {
      try {
        const result = await proxyProposeUpgrade(contractId, options);
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
    });

  contract
    .command('proxy-approve-upgrade <contractId>')
    .description('Approve a pending proxy upgrade proposal (#224)')
    .option('--proposal-id <id>', 'Proposal ID to approve')
    .option('--server <url>', 'Soroban RPC server URL')
    .option('--network <name>', 'Target network (testnet, futurenet, mainnet)')
    .option('--secret <key>', 'Secret key used to sign the invocation')
    .option('--json', 'Emit machine-readable JSON output')
    .action(async (contractId: string, options: ProxyOptions) => {
      try {
        const result = await proxyApproveUpgrade(contractId, options);
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
    });

  contract
    .command('proxy-execute-upgrade <contractId>')
    .description('Execute a timelocked proxy upgrade (#224)')
    .option('--proposal-id <id>', 'Proposal ID to execute')
    .option('--server <url>', 'Soroban RPC server URL')
    .option('--network <name>', 'Target network (testnet, futurenet, mainnet)')
    .option('--secret <key>', 'Secret key used to sign the invocation')
    .option('--json', 'Emit machine-readable JSON output')
    .action(async (contractId: string, options: ProxyOptions) => {
      try {
        const result = await proxyExecuteUpgrade(contractId, options);
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
    });

  contract
    .command('inheritance-heartbeat <contractId>')
    .description('Record a heartbeat on the inheritance vault (#225)')
    .option('--server <url>', 'Soroban RPC server URL')
    .option('--network <name>', 'Target network (testnet, futurenet, mainnet)')
    .option('--secret <key>', 'Secret key used to sign the invocation')
    .option('--json', 'Emit machine-readable JSON output')
    .action(async (contractId: string, options: InheritanceOptions) => {
      try {
        const result = await inheritanceHeartbeat(contractId, options);
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
    });

  contract
    .command('inheritance-claim <contractId>')
    .description('Claim custody from the inheritance vault once dormant (#225)')
    .option('--beneficiary <address>', 'Beneficiary account address')
    .option('--server <url>', 'Soroban RPC server URL')
    .option('--network <name>', 'Target network (testnet, futurenet, mainnet)')
    .option('--secret <key>', 'Secret key used to sign the invocation')
    .option('--json', 'Emit machine-readable JSON output')
    .action(async (contractId: string, options: InheritanceOptions) => {
      try {
        const result = await inheritanceClaim(contractId, options);
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
    });

  return contract;
}

export default registerContractCommand;