import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { TransactionBuilder, Networks, Transaction } from '@stellar/stellar-sdk';

/**
 * Shape of a single policy rule as defined in the policy JSON file.
 */
export interface PolicyRule {
  id: string;
  name?: string;
  type: string;
  description?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

/**
 * Shape of the policy document loaded from disk.
 */
export interface PolicyDocument {
  version?: string;
  name?: string;
  rules: PolicyRule[];
  velocity?: VelocityConfig;
  [key: string]: unknown;
}

/**
 * Velocity / spend allowance configuration.
 */
export interface VelocityConfig {
  windowSeconds?: number;
  maxAmount?: string;
  maxTransactions?: number;
  asset?: string;
  [key: string]: unknown;
}

/**
 * Result of evaluating a single rule against a transaction.
 */
export interface RuleEvaluationResult {
  id: string;
  name: string;
  type: string;
  passed: boolean;
  reason: string;
  details?: Record<string, unknown>;
}

/**
 * Remaining velocity allowance after accounting for the candidate transaction.
 */
export interface VelocityAllowance {
  windowSeconds: number;
  asset: string;
  maxAmount: string;
  remainingAmount: string;
  maxTransactions: number;
  remainingTransactions: number;
}

/**
 * Full simulation result returned by the engine.
 */
export interface SimulationResult {
  approved: boolean;
  reason: string;
  policyName: string;
  rules: RuleEvaluationResult[];
  velocity?: VelocityAllowance;
  transaction: {
    hash: string;
    sourceAccount: string;
    fee: string;
    operationCount: number;
    network: string;
  };
}

export interface PolicySimulateOptions {
  policy: string;
  xdr: string;
  network?: string;
  json?: boolean;
}

const DEFAULT_NETWORK = 'public';

function resolveNetworkPassphrase(network: string): string {
  switch (network.toLowerCase()) {
    case 'public':
    case 'mainnet':
      return Networks.PUBLIC;
    case 'testnet':
      return Networks.TESTNET;
    case 'futurenet':
      return Networks.FUTURENET;
    default:
      // Allow passing a raw network passphrase.
      return network;
  }
}

/**
 * Load and validate a policy JSON document from disk.
 */
export function loadPolicy(policyPath: string): PolicyDocument {
  let raw: string;
  try {
    raw = readFileSync(policyPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Unable to read policy file at "${policyPath}": ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Policy file "${policyPath}" is not valid JSON: ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Policy file "${policyPath}" must contain a JSON object at the top level.`,
    );
  }

  const doc = parsed as PolicyDocument;

  if (!Array.isArray(doc.rules)) {
    throw new Error(
      `Policy file "${policyPath}" is missing a "rules" array.`,
    );
  }

  doc.rules.forEach((rule, index) => {
    if (typeof rule !== 'object' || rule === null) {
      throw new Error(`Policy rule at index ${index} must be an object.`);
    }
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      throw new Error(`Policy rule at index ${index} is missing a string "id".`);
    }
    if (typeof rule.type !== 'string' || rule.type.length === 0) {
      throw new Error(
        `Policy rule "${rule.id}" is missing a string "type".`,
      );
    }
  });

  return doc;
}

/**
 * Decode a base64 transaction envelope XDR into a Transaction object.
 */
export function decodeTransaction(
  xdr: string,
  network: string,
): Transaction {
  const passphrase = resolveNetworkPassphrase(network);
  try {
    return TransactionBuilder.fromXDR(xdr, passphrase) as Transaction;
  } catch (err) {
    throw new Error(
      `Failed to decode transaction XDR: ${(err as Error).message}`,
    );
  }
}

/**
 * Evaluate a single rule against a decoded transaction.
 *
 * This is a lightweight, deterministic evaluator intended for offline
 * dry-run simulation. Rules that are not recognized are reported as
 * skipped (passing) with an explanatory reason so that unknown rule types
 * do not silently block evaluation.
 */
export function evaluateRule(
  rule: PolicyRule,
  tx: Transaction,
): RuleEvaluationResult {
  const name = rule.name ?? rule.id;
  const enabled = rule.enabled !== false;

  if (!enabled) {
    return {
      id: rule.id,
      name,
      type: rule.type,
      passed: true,
      reason: 'Rule is disabled and was skipped.',
    };
  }

  const operations = tx.operations ?? [];

  switch (rule.type) {
    case 'max-operations': {
      const max = Number(rule.max ?? rule.value ?? 0);
      const count = operations.length;
      const passed = count <= max;
      return {
        id: rule.id,
        name,
        type: rule.type,
        passed,
        reason: passed
          ? `Transaction has ${count} operation(s), within the limit of ${max}.`
          : `Transaction has ${count} operation(s), exceeding the limit of ${max}.`,
        details: { count, max },
      };
    }

    case 'allowed-operations': {
      const allowed = Array.isArray(rule.allowed)
        ? (rule.allowed as string[])
        : [];
      const disallowed = operations
        .map((op) => op.type)
        .filter((type) => !allowed.includes(type));
      const passed = disallowed.length === 0;
      return {
        id: rule.id,
        name,
        type: rule.type,
        passed,
        reason: passed
          ? `All ${operations.length} operation(s) are in the allowed set.`
          : `Disallowed operation type(s): ${disallowed.join(', ')}.`,
        details: { allowed, disallowed },
      };
    }

    case 'max-fee': {
      const max = BigInt(String(rule.max ?? rule.value ?? '0'));
      const fee = BigInt(tx.fee);
      const passed = fee <= max;
      return {
        id: rule.id,
        name,
        type: rule.type,
        passed,
        reason: passed
          ? `Transaction fee ${fee.toString()} stroops is within the limit of ${max.toString()}.`
          : `Transaction fee ${fee.toString()} stroops exceeds the limit of ${max.toString()}.`,
        details: { fee: fee.toString(), max: max.toString() },
      };
    }

    case 'allowed-source': {
      const allowed = Array.isArray(rule.allowed)
        ? (rule.allowed as string[])
        : [];
      const source = tx.source;
      const passed = allowed.length === 0 || allowed.includes(source);
      return {
        id: rule.id,
        name,
        type: rule.type,
        passed,
        reason: passed
          ? `Source account ${source} is permitted.`
          : `Source account ${source} is not in the allowed list.`,
        details: { source, allowed },
      };
    }

    case 'denied-source': {
      const denied = Array.isArray(rule.denied)
        ? (rule.denied as string[])
        : [];
      const source = tx.source;
      const passed = !denied.includes(source);
      return {
        id: rule.id,
        name,
        type: rule.type,
        passed,
        reason: passed
          ? `Source account ${source} is not denied.`
          : `Source account ${source} is explicitly denied.`,
        details: { source, denied },
      };
    }

    case 'memo-required': {
      const hasMemo = tx.memo && tx.memo.value !== undefined && tx.memo.value !== null;
      const passed = Boolean(hasMemo);
      return {
        id: rule.id,
        name,
        type: rule.type,
        passed,
        reason: passed
          ? 'Transaction includes a memo.'
          : 'Transaction is missing a required memo.',
      };
    }

    case 'time-bound': {
      const now = Math.floor(Date.now() / 1000);
      const notBefore = rule.notBefore ? Number(rule.notBefore) : undefined;
      const notAfter = rule.notAfter ? Number(rule.notAfter) : undefined;
      let passed = true;
      let reason = 'Transaction is within the allowed time window.';
      if (notBefore !== undefined && now < notBefore) {
        passed = false;
        reason = `Current time ${now} is before the allowed window start ${notBefore}.`;
      } else if (notAfter !== undefined && now > notAfter) {
        passed = false;
        reason = `Current time ${now} is after the allowed window end ${notAfter}.`;
      }
      return {
        id: rule.id,
        name,
        type: rule.type,
        passed,
        reason,
        details: { now, notBefore, notAfter },
      };
    }

    default:
      return {
        id: rule.id,
        name,
        type: rule.type,
        passed: true,
        reason: `Unknown rule type "${rule.type}" was skipped during simulation.`,
      };
  }
}

/**
 * Compute remaining velocity / spend allowance for the candidate transaction.
 */
export function computeVelocityAllowance(
  policy: PolicyDocument,
  tx: Transaction,
): VelocityAllowance | undefined {
  const velocity = policy.velocity;
  if (!velocity) {
    return undefined;
  }

  const windowSeconds = Number(velocity.windowSeconds ?? 86400);
  const asset = String(velocity.asset ?? 'XLM');
  const maxAmount = String(velocity.maxAmount ?? '0');
  const maxTransactions = Number(velocity.maxTransactions ?? 0);

  // Offline simulation has no historical ledger of prior usage, so the
  // candidate transaction is treated as the only usage in the window.
  const txAmount = BigInt(String(velocity.txAmount ?? '0'));
  const maxAmountBig = BigInt(maxAmount);
  const remainingAmount =
    maxAmountBig > txAmount ? maxAmountBig - txAmount : BigInt(0);

  const remainingTransactions = maxTransactions > 0 ? maxTransactions - 1 : 0;

  return {
    windowSeconds,
    asset,
    maxAmount,
    remainingAmount: remainingAmount.toString(),
    maxTransactions,
    remainingTransactions: remainingTransactions < 0 ? 0 : remainingTransactions,
  };
}

/**
 * Run the full policy simulation for a transaction.
 */
export function simulatePolicy(
  policy: PolicyDocument,
  tx: Transaction,
  network: string,
): SimulationResult {
  const rules = policy.rules.map((rule) => evaluateRule(rule, tx));
  const failed = rules.filter((r) => !r.passed);

  const approved = failed.length === 0;
  const reason = approved
    ? `All ${rules.length} policy rule(s) passed.`
    : `${failed.length} of ${rules.length} policy rule(s) failed: ${failed
        .map((r) => r.id)
        .join(', ')}.`;

  return {
    approved,
    reason,
    policyName: policy.name ?? 'unnamed-policy',
    rules,
    velocity: computeVelocityAllowance(policy, tx),
    transaction: {
      hash: tx.hash().toString('hex'),
      sourceAccount: tx.source,
      fee: tx.fee,
      operationCount: (tx.operations ?? []).length,
      network,
    },
  };
}

function colorizePass(passed: boolean): string {
  return passed ? chalk.green('PASS') : chalk.red('FAIL');
}

/**
 * Render the simulation result as a colored terminal table.
 */
export function renderTable(result: SimulationResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold.cyan('Lumen Policy Simulation'));
  lines.push(chalk.gray('─'.repeat(72)));
  lines.push(`${chalk.bold('Policy:')}      ${result.policyName}`);
  lines.push(`${chalk.bold('Network:')}     ${result.transaction.network}`);
  lines.push(`${chalk.bold('Tx Hash:')}     ${result.transaction.hash}`);
  lines.push(`${chalk.bold('Source:')}      ${result.transaction.sourceAccount}`);
  lines.push(`${chalk.bold('Fee:')}         ${result.transaction.fee} stroops`);
  lines.push(
    `${chalk.bold('Operations:')}  ${result.transaction.operationCount}`,
  );
  lines.push('');

  const idWidth = Math.max(
    4,
    ...result.rules.map((r) => r.id.length),
  );
  const nameWidth = Math.max(
    4,
    ...result.rules.map((r) => r.name.length),
  );
  const typeWidth = Math.max(
    4,
    ...result.rules.map((r) => r.type.length),
  );

  const header =
    chalk.bold('ID'.padEnd(idWidth)) +
    '  ' +
    chalk.bold('NAME'.padEnd(nameWidth)) +
    '  ' +
    chalk.bold('TYPE'.padEnd(typeWidth)) +
    '  ' +
    chalk.bold('RESULT');
  lines.push(header);
  lines.push(chalk.gray('─'.repeat(72)));

  for (const rule of result.rules) {
    const row =
      rule.id.padEnd(idWidth) +
      '  ' +
      rule.name.padEnd(nameWidth) +
      '  ' +
      rule.type.padEnd(typeWidth) +
      '  ' +
      colorizePass(rule.passed);
    lines.push(row);
    lines.push(chalk.gray(`    ↳ ${rule.reason}`));
  }

  lines.push(chalk.gray('─'.repeat(72)));

  if (result.velocity) {
    lines.push('');
    lines.push(chalk.bold.cyan('Remaining Velocity Allowance'));
    lines.push(
      `  Window:        ${result.velocity.windowSeconds}s`,
    );
    lines.push(`  Asset:         ${result.velocity.asset}`);
    lines.push(
      `  Amount:        ${result.velocity.remainingAmount} / ${result.velocity.maxAmount}`,
    );
    lines.push(
      `  Transactions:  ${result.velocity.remainingTransactions} / ${result.velocity.maxTransactions}`,
    );
  }

  lines.push('');
  if (result.approved) {
    lines.push(chalk.bold.green(`✔ APPROVED — ${result.reason}`));
  } else {
    lines.push(chalk.bold.red(`✘ REJECTED — ${result.reason}`));
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Execute the policy simulation command.
 */
export async function runPolicySimulate(
  options: PolicySimulateOptions,
): Promise<SimulationResult> {
  const network = options.network ?? DEFAULT_NETWORK;
  const policy = loadPolicy(options.policy);
  const tx = decodeTransaction(options.xdr, network);
  const result = simulatePolicy(policy, tx, network);

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(renderTable(result) + '\n');
  }

  return result;
}

/**
 * Register the `lumen policy test` command.
 */
export function registerPolicySimulateCommand(program: Command): Command {
  const policyCommand = program
    .command('policy')
    .description('Policy management and evaluation commands');

  policyCommand
    .command('test')
    .description(
      'Dry-run a transaction envelope against a policy file and report rule-by-rule results',
    )
    .requiredOption(
      '-p, --policy <path>',
      'Path to the policy JSON file to evaluate',
    )
    .requiredOption(
      '-x, --xdr <xdr>',
      'Base64-encoded transaction envelope XDR to simulate',
    )
    .option(
      '-n, --network <network>',
      'Stellar network (public, testnet, futurenet, or a raw passphrase)',
      DEFAULT_NETWORK,
    )
    .option('--json', 'Output machine-readable JSON instead of a table')
    .action(async (opts: PolicySimulateOptions) => {
      try {
        const result = await runPolicySimulate(opts);
        if (!result.approved) {
          process.exitCode = 1;
        }
      } catch (err) {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ error: (err as Error).message }, null, 2) + '\n',
          );
        } else {
          process.stderr.write(
            chalk.red(`Error: ${(err as Error).message}`) + '\n',
          );
        }
        process.exitCode = 1;
      }
    });

  return policyCommand;
}

export default registerPolicySimulateCommand;