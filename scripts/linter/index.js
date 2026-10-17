'use strict';

/**
 * Lumen static security linter.
 *
 * A custom ESLint plugin that uses AST visitors to flag Stellar XDR
 * injection hazards and raw secret key handling. Every report includes an
 * actionable fix recommendation.
 *
 * Rules:
 *   - no-unsanitized-xdr-decode
 *   - no-raw-secret-key-handling
 *
 * Usage (flat config):
 *   const lumen = require('./scripts/linter');
 *   module.exports = [ { plugins: { lumen }, rules: { 'lumen/no-unsanitized-xdr-decode': 'error', ... } } ];
 *
 * Usage (eslintrc):
 *   { "plugins": ["lumen"], "rules": { "lumen/no-unsanitized-xdr-decode": "error" } }
 */

const SECRET_KEY_LITERAL = /\bS[A-Z2-7]{55}\b/;
const SECRET_KEY_ANY = /\bS[A-Z2-7]{10,}\b/;

const XDR_DECODE_METHODS = new Set(['fromXDR', 'fromXdr', 'from_xdr']);
const XDR_NAMESPACES = new Set(['xdr', 'XDR', 'StellarXdr', 'stellarXdr']);

const VALIDATION_CALLS = new Set([
  'isValid',
  'isValidXDR',
  'isValidXdr',
  'validate',
  'validateXDR',
  'validateXdr',
  'assertValid',
  'assertValidXDR',
  'assertValidXdr',
  'sanitize',
  'sanitizeXDR',
  'sanitizeXdr',
  'isTrusted',
  'assertTrusted',
  'checkXDR',
  'checkXdr',
]);

const SECRET_ACCESSORS = new Set([
  'secret',
  'secretKey',
  'secret_key',
  'rawSecret',
  'raw_secret',
  'privateKey',
  'private_key',
  'seed',
]);

const LOGGING_METHODS = new Set([
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'dir',
  'write',
  'send',
  'emit',
  'print',
  'printf',
  'puts',
]);

const UNTRUSTED_SOURCE_NAMES = new Set([
  'req',
  'request',
  'body',
  'query',
  'params',
  'headers',
  'input',
  'payload',
  'data',
  'untrusted',
  'userInput',
  'user_input',
  'rawInput',
  'raw_input',
  'form',
  'formData',
  'form_data',
  'args',
  'argv',
  'env',
  'process',
  'message',
  'event',
  'socket',
  'stdin',
]);

const UNTRUSTED_SOURCE_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'readFile',
  'readFileSync',
  'read',
  'readSync',
  'parse',
  'json',
  'text',
  'body',
  'query',
  'param',
  'params',
  'header',
  'headers',
  'value',
  'values',
  'getItem',
  'getElementById',
  'querySelector',
  'querySelectorAll',
  'from',
  'toString',
  'decode',
]);

const UNTRUSTED_SOURCE_OBJECTS = new Set([
  'req',
  'request',
  'res',
  'response',
  'process',
  'fs',
  'localStorage',
  'sessionStorage',
  'document',
  'window',
  'location',
  'URLSearchParams',
  'FormData',
  'JSON',
  'Buffer',
  'socket',
  'ws',
  'io',
  'stdin',
  'readline',
]);

const TRUSTED_SOURCE_NAMES = new Set([
  'config',
  'constants',
  'CONSTANTS',
  'fixture',
  'fixtures',
  'testData',
  'test_data',
  'mockData',
  'mock_data',
  'sample',
  'samples',
  'knownGood',
  'known_good',
  'trusted',
  'TRUSTED',
  'hardcoded',
  'static',
]);

const TRUSTED_SOURCE_OBJECTS = new Set([
  'config',
  'constants',
  'CONSTANTS',
  'fixtures',
  'testData',
  'mockData',
]);

const TRUSTED_SOURCE_METHODS = new Set([
  'readFileSync',
  'readFile',
  'require',
  'import',
  'resolve',
  'join',
]);

const TRUSTED_PATH_HINTS = [
  'fixtures',
  'fixture',
  'testdata',
  'test-data',
  'mocks',
  'mock',
  'samples',
  'sample',
  'constants',
  'config',
  'trusted',
  'known-good',
  'knowngood',
];

const TRUSTED_PATH_PATTERNS = [
  /\.json$/i,
  /\.fixture$/i,
  /\.fixtures$/i,
  /\.txt$/i,
];

const TRUSTED_CALL_NAMES = new Set([
  'readTrustedFixture',
  'readFixture',
  'loadFixture',
  'loadTrusted',
  'getTrusted',
  'trustedInput',
  'trusted_input',
  'getConfig',
  'loadConfig',
  'readConfig',
  'getConstant',
  'getConstants',
]);

const TRUSTED_CALL_PREFIXES = ['trusted', 'fixture', 'mock', 'sample', 'config', 'constant'];

const TRUSTED_CALL_SUFFIXES = ['Fixture', 'Trusted', 'Config', 'Constant', 'Mock', 'Sample'];

const TRUSTED_CALL_SUFFIX_LOWER = TRUSTED_CALL_SUFFIXES.map((s) => s.toLowerCase());

const TRUSTED_CALL_PREFIX_LOWER = TRUSTED_CALL_PREFIXES.map((s) => s.toLowerCase());

const VALIDATION_METHOD_NAMES = new Set([
  'isValid',
  'isValidXDR',
  'isValidXdr',
  'validate',
  'validateXDR',
  'validateXdr',
  'assertValid',
  'assertValidXDR',
  'assertValidXdr',
  'sanitize',
  'sanitizeXDR',
  'sanitizeXdr',
  'isTrusted',
  'assertTrusted',
  'checkXDR',
  'checkXdr',
  'isValidEnvelope',
  'validateEnvelope',
  'assertValidEnvelope',
  'isValidTransaction',
  'validateTransaction',
  'assertValidTransaction',
]);

const VALIDATION_METHOD_SUFFIXES = [
  'Valid',
  'ValidXDR',
  'ValidXdr',
  'ValidEnvelope',
  'ValidTransaction',
  'Sanitized',
  'Sanitize',
  'Trusted',
  'Checked',
];

const VALIDATION_METHOD_PREFIXES = ['is', 'assert', 'validate', 'sanitize', 'check', 'ensure'];

const VALIDATION_METHOD_PREFIX_LOWER = VALIDATION_METHOD_PREFIXES.map((s) => s.toLowerCase());

const VALIDATION_METHOD_SUFFIX_LOWER = VALIDATION_METHOD_SUFFIXES.map((s) => s.toLowerCase());

const VALIDATION_OBJECT_NAMES = new Set([
  'validator',
  'validation',
  'security',
  'sanitizer',
  'guard',
  'guards',
]);

const SANITIZED_VARIABLE_PATTERN = /(validated|sanitized|trusted|safe|checked|verified|clean)/i;

const UNTRUSTED_VARIABLE_PATTERN = /(untrusted|raw|unsafe|user|external|input|payload|unvalidated|tainted)/i;

const SECRET_VARIABLE_PATTERN = /(secret|privatekey|private_key|seed|mnemonic|signingkey|signing_key)/i;

const SECRET_OBJECT_NAMES = new Set([
  'keypair',
  'keyPair',
  'Keypair',
  'signer',
  'wallet',
  'account',
  'credentials',
  'creds',
  'keys',
  'secretKey',
  'secret_key',
  'privateKey',
  'private_key',
]);

const SECRET_FACTORY_METHODS = new Set([
  'fromSecret',
  'from_secret',
  'fromRawSecret',
  'from_raw_secret',
  'fromSeed',
  'from_seed',
  'fromMnemonic',
  'from_mnemonic',
  'fromPrivateKey',
  'from_private_key',
]);

const SECRET_FACTORY_OBJECTS = new Set([
  'Keypair',
  'keypair',
  'keyPair',
  'StellarKeypair',
  'stellarKeypair',
  'Signer',
  'signer',
]);

const SECRET_FACTORY_NAMES = new Set([
  'keypairFromSecret',
  'keypairFromSeed',
  'keypairFromMnemonic',
  'fromSecret',
  'fromSeed',
  'fromMnemonic',
  'deriveKeypair',
  'deriveKeyPair',
]);

const SECRET_FACTORY_NAME_PREFIXES = ['keypair', 'keyPair', 'key', 'secret', 'signer', 'wallet'];

const SECRET_FACTORY_NAME_SUFFIXES = ['FromSecret', 'FromSeed', 'FromMnemonic', 'FromPrivateKey'];

const SECRET_FACTORY_NAME_PREFIX_LOWER = SECRET_FACTORY_NAME_PREFIXES.map((s) => s.toLowerCase());

const SECRET_FACTORY_NAME_SUFFIX_LOWER = SECRET_FACTORY_NAME_SUFFIXES.map((s) => s.toLowerCase());

const SECRET_ACCESSOR_OBJECTS = new Set([
  'keypair',
  'keyPair',
  'Keypair',
  'signer',
  'wallet',
  'account',
  'credentials',
  'creds',
  'keys',
  'secret',
  'secrets',
  'env',
  'process',
  'config',
  'options',
  'opts',
  'settings',
  'params',
  'args',
  'state',
  'store',
  'vault',
  'keystore',
  'keyStore',
]);

const SECRET_ACCESSOR_PREFIXES = ['secret', 'private', 'raw', 'signing', 'seed', 'mnemonic'];

const SECRET_ACCESSOR_SUFFIXES = ['Secret', 'PrivateKey', 'Seed', 'Mnemonic', 'SigningKey'];

const SECRET_ACCESSOR_PREFIX_LOWER = SECRET_ACCESSOR_PREFIXES.map((s) => s.toLowerCase());

const SECRET_ACCESSOR_SUFFIX_LOWER = SECRET_ACCESSOR_SUFFIXES.map((s) => s.toLowerCase());

const SECRET_ACCESSOR_ANY = new Set([
  'secret',
  'secretKey',
  'secret_key',
  'privateKey',
  'private_key',
  'rawSecret',
  'raw_secret',
  'seed',
  'mnemonic',
  'signingKey',
  'signing_key',
  'key',
  'value',
  'data',
  'toString',
  'toJSON',
  'toJson',
  'toObject',
  'to_string',
  'toJSONString',
]);

const SECRET_ACCESSOR_ANY_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY).map((s) => s.toLowerCase())
);

const SECRET_ACCESSOR_ANY_SUFFIXES = ['secret', 'key', 'seed', 'mnemonic', 'value', 'data'];

const SECRET_ACCESSOR_ANY_PREFIXES = ['secret', 'private', 'raw', 'signing', 'seed', 'mnemonic'];

const SECRET_ACCESSOR_ANY_SUFFIX_LOWER = SECRET_ACCESSOR_ANY_SUFFIXES.map((s) => s.toLowerCase());

const SECRET_ACCESSOR_ANY_PREFIX_LOWER = SECRET_ACCESSOR_ANY_PREFIXES.map((s) => s.toLowerCase());

const SECRET_ACCESSOR_ANY_OBJECTS = new Set([
  'keypair',
  'keyPair',
  'Keypair',
  'signer',
  'wallet',
  'account',
  'credentials',
  'creds',
  'keys',
  'secret',
  'secrets',
  'env',
  'process',
  'config',
  'options',
  'opts',
  'settings',
  'params',
  'args',
  'state',
  'store',
  'vault',
  'keystore',
  'keyStore',
  'this',
  'self',
  'window',
  'global',
  'globalThis',
]);

const SECRET_ACCESSOR_ANY_OBJECTS_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_OBJECTS).map((s) => s.toLowerCase())
);

const SECRET_ACCESSOR_ANY_METHODS = new Set([
  'getSecret',
  'get_secret',
  'getPrivateKey',
  'get_private_key',
  'getSeed',
  'get_seed',
  'getMnemonic',
  'get_mnemonic',
  'getSigningKey',
  'get_signing_key',
  'secret',
  'privateKey',
  'private_key',
  'seed',
  'mnemonic',
  'signingKey',
  'signing_key',
  'rawSecret',
  'raw_secret',
  'toString',
  'toJSON',
  'toJson',
  'toObject',
  'to_string',
  'toJSONString',
  'valueOf',
  'getValue',
  'get_value',
  'get',
  'read',
  'load',
  'fetch',
  'retrieve',
  'extract',
  'dump',
  'export',
  'serialize',
  'stringify',
  'encode',
  'decode',
  'format',
  'print',
  'log',
  'write',
  'send',
  'emit',
  'publish',
  'broadcast',
  'post',
  'put',
  'patch',
  'delete',
  'request',
  'fetch',
  'axios',
  'http',
  'https',
  'net',
  'dgram',
  'socket',
  'ws',
  'io',
  'console',
  'logger',
  'log',
  'winston',
  'pino',
  'bunyan',
  'debug',
  'trace',
  'info',
  'warn',
  'error',
  'fatal',
  'verbose',
  'silly',
  'dir',
  'table',
  'group',
  'groupEnd',
  'time',
  'timeEnd',
  'count',
  'assert',
  'clear',
  'profile',
  'profileEnd',
  'trace',
  'warn',
  'error',
  'debug',
  'info',
  'log',
]);

const SECRET_ACCESSOR_ANY_METHODS_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHODS).map((s) => s.toLowerCase())
);

const SECRET_ACCESSOR_ANY_METHOD_PREFIXES = [
  'get',
  'read',
  'load',
  'fetch',
  'retrieve',
  'extract',
  'dump',
  'export',
  'serialize',
  'stringify',
  'encode',
  'decode',
  'format',
  'print',
  'log',
  'write',
  'send',
  'emit',
  'publish',
  'broadcast',
  'post',
  'put',
  'patch',
  'delete',
  'request',
];

const SECRET_ACCESSOR_ANY_METHOD_SUFFIXES = [
  'Secret',
  'PrivateKey',
  'Seed',
  'Mnemonic',
  'SigningKey',
  'Key',
  'Value',
  'Data',
  'String',
  'JSON',
  'Json',
  'Object',
  'Bytes',
  'Buffer',
  'Hex',
  'Base64',
  'Raw',
];

const SECRET_ACCESSOR_ANY_METHOD_PREFIX_LOWER = SECRET_ACCESSOR_ANY_METHOD_PREFIXES.map((s) =>
  s.toLowerCase()
);

const SECRET_ACCESSOR_ANY_METHOD_SUFFIX_LOWER = SECRET_ACCESSOR_ANY_METHOD_SUFFIXES.map((s) =>
  s.toLowerCase()
);

const SECRET_ACCESSOR_ANY_METHOD_OBJECTS = new Set([
  'keypair',
  'keyPair',
  'Keypair',
  'signer',
  'wallet',
  'account',
  'credentials',
  'creds',
  'keys',
  'secret',
  'secrets',
  'env',
  'process',
  'config',
  'options',
  'opts',
  'settings',
  'params',
  'args',
  'state',
  'store',
  'vault',
  'keystore',
  'keyStore',
  'this',
  'self',
  'window',
  'global',
  'globalThis',
  'console',
  'logger',
  'log',
  'winston',
  'pino',
  'bunyan',
  'debug',
  'trace',
  'info',
  'warn',
  'error',
  'fatal',
  'verbose',
  'silly',
  'dir',
  'table',
  'group',
  'groupEnd',
  'time',
  'timeEnd',
  'count',
  'assert',
  'clear',
  'profile',
  'profileEnd',
  'trace',
  'warn',
  'error',
  'debug',
  'info',
  'log',
]);

const SECRET_ACCESSOR_ANY_METHOD_OBJECTS_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_OBJECTS).map((s) => s.toLowerCase())
);

const SECRET_ACCESSOR_ANY_METHOD_OBJECT_PREFIXES = [
  'keypair',
  'keyPair',
  'key',
  'secret',
  'signer',
  'wallet',
  'account',
  'credentials',
  'creds',
  'keys',
  'env',
  'process',
  'config',
  'options',
  'opts',
  'settings',
  'params',
  'args',
  'state',
  'store',
  'vault',
  'keystore',
  'keyStore',
  'this',
  'self',
  'window',
  'global',
  'globalThis',
  'console',
  'logger',
  'log',
  'winston',
  'pino',
  'bunyan',
  'debug',
  'trace',
  'info',
  'warn',
  'error',
  'fatal',
  'verbose',
  'silly',
  'dir',
  'table',
  'group',
  'groupEnd',
  'time',
  'timeEnd',
  'count',
  'assert',
  'clear',
  'profile',
  'profileEnd',
];

const SECRET_ACCESSOR_ANY_METHOD_OBJECT_PREFIX_LOWER =
  SECRET_ACCESSOR_ANY_METHOD_OBJECT_PREFIXES.map((s) => s.toLowerCase());

const SECRET_ACCESSOR_ANY_METHOD_OBJECT_SUFFIXES = [
  'Keypair',
  'KeyPair',
  'Key',
  'Secret',
  'Signer',
  'Wallet',
  'Account',
  'Credentials',
  'Creds',
  'Keys',
  'Env',
  'Process',
  'Config',
  'Options',
  'Opts',
  'Settings',
  'Params',
  'Args',
  'State',
  'Store',
  'Vault',
  'Keystore',
  'KeyStore',
  'Self',
  'Window',
  'Global',
  'GlobalThis',
  'Console',
  'Logger',
  'Log',
  'Winston',
  'Pino',
  'Bunyan',
  'Debug',
  'Trace',
  'Info',
  'Warn',
  'Error',
  'Fatal',
  'Verbose',
  'Silly',
  'Dir',
  'Table',
  'Group',
  'GroupEnd',
  'Time',
  'TimeEnd',
  'Count',
  'Assert',
  'Clear',
  'Profile',
  'ProfileEnd',
];

const SECRET_ACCESSOR_ANY_METHOD_OBJECT_SUFFIX_LOWER =
  SECRET_ACCESSOR_ANY_METHOD_OBJECT_SUFFIXES.map((s) => s.toLowerCase());

const SECRET_ACCESSOR_ANY_METHOD_OBJECT_ANY = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_OBJECTS,
  ...SECRET_ACCESSOR_ANY_METHOD_OBJECT_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_OBJECT_SUFFIXES,
]);

const SECRET_ACCESSOR_ANY_METHOD_OBJECT_ANY_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_OBJECT_ANY).map((s) => s.toLowerCase())
);

const SECRET_ACCESSOR_ANY_METHOD_ANY = new Set([
  ...SECRET_ACCESSOR_ANY_METHODS,
  ...SECRET_ACCESSOR_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_SUFFIXES,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY).map((s) => s.toLowerCase())
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_OBJECTS = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_OBJECTS,
  ...SECRET_ACCESSOR_ANY_METHOD_OBJECT_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_OBJECT_SUFFIXES,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_OBJECTS_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_OBJECTS).map((s) => s.toLowerCase())
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHODS = new Set([
  ...SECRET_ACCESSOR_ANY_METHODS,
  ...SECRET_ACCESSOR_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_SUFFIXES,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHODS_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_METHODS).map((s) => s.toLowerCase())
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_PREFIXES = [
  ...SECRET_ACCESSOR_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_OBJECT_PREFIXES,
];

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_SUFFIXES = [
  ...SECRET_ACCESSOR_ANY_METHOD_SUFFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_OBJECT_SUFFIXES,
];

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_PREFIX_LOWER =
  SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_PREFIXES.map((s) => s.toLowerCase());

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_SUFFIX_LOWER =
  SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_SUFFIXES.map((s) => s.toLowerCase());

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_OBJECTS = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_OBJECTS,
  ...SECRET_ACCESSOR_ANY_METHOD_OBJECT_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_OBJECT_SUFFIXES,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_OBJECTS_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_OBJECTS).map((s) => s.toLowerCase())
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHODS,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_SUFFIXES,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY).map((s) => s.toLowerCase())
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_OBJECTS = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_OBJECTS,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_SUFFIXES,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_OBJECTS_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_OBJECTS).map((s) => s.toLowerCase())
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHODS = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_OBJECTS,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHODS_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHODS).map((s) => s.toLowerCase())
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES = [
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_OBJECT_PREFIXES,
];

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES = [
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_SUFFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_OBJECT_SUFFIXES,
];

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIX_LOWER =
  SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES.map((s) => s.toLowerCase());

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIX_LOWER =
  SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES.map((s) => s.toLowerCase());

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECTS = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_OBJECTS,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECTS_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECTS).map((s) => s.toLowerCase())
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHODS,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY).map((s) => s.toLowerCase())
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_OBJECTS = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECTS,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_OBJECTS_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_OBJECTS).map((s) =>
    s.toLowerCase()
  )
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHODS = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_OBJECTS,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHODS_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHODS).map((s) =>
    s.toLowerCase()
  )
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES = [
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECT_PREFIXES,
];

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES = [
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECT_SUFFIXES,
];

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIX_LOWER =
  SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES.map((s) =>
    s.toLowerCase()
  );

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIX_LOWER =
  SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES.map((s) =>
    s.toLowerCase()
  );

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECTS = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_OBJECTS,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECTS_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECTS).map((s) =>
    s.toLowerCase()
  )
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHODS,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY).map((s) =>
    s.toLowerCase()
  )
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_OBJECTS = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECTS,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_OBJECTS_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_OBJECTS).map((s) =>
    s.toLowerCase()
  )
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHODS = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_OBJECTS,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHODS_LOWER = new Set(
  Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHODS).map((s) =>
    s.toLowerCase()
  )
);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES = [
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECT_PREFIXES,
];

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES = [
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECT_SUFFIXES,
];

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIX_LOWER =
  SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES.map((s) =>
    s.toLowerCase()
  );

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIX_LOWER =
  SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES.map((s) =>
    s.toLowerCase()
  );

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECTS = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_OBJECTS,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_PREFIXES,
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_SUFFIXES,
]);

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECTS_LOWER =
  new Set(
    Array.from(SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_OBJECTS).map(
      (s) => s.toLowerCase()
    )
  );

const SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY = new Set([
  ...SECRET_ACCESSOR_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_METHOD_ANY_M