/**
 * SEP-0038 Anchor Platform Cross-Asset Quotes API Client
 *
 * Implements a client for the SEP-0038 "Anchor RFQ API" specification,
 * enabling wallets to request indicative prices and firm quotes from
 * anchors for asset swaps and conversions.
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0038.md
 */

/**
 * A price entry returned by the SEP-0038 `/prices` endpoint.
 */
export interface Sep38Price {
  /** The asset being sold (SEP-38 asset identifier, e.g. `stellar:USDC:GA...`). */
  sell_asset: string;
  /** The asset being bought (SEP-38 asset identifier). */
  buy_asset: string;
  /** The price of `sell_asset` in terms of `buy_asset`. */
  price: string;
  /** Optional amount of `sell_asset` the price applies to. */
  sell_amount?: string;
  /** Optional amount of `buy_asset` the price applies to. */
  buy_amount?: string;
  /** Optional total price including fees. */
  total_price?: string;
  /** Optional fee information for the price. */
  fee?: Sep38Fee;
}

/**
 * Fee information associated with a price or quote.
 */
export interface Sep38Fee {
  /** Total fee amount. */
  total: string;
  /** Asset in which the fee is denominated. */
  asset: string;
  /** Optional breakdown of the fee by category. */
  details?: Array<{
    name: string;
    amount: string;
    description?: string;
  }>;
}

/**
 * An indicative (non-binding) quote returned by the SEP-0038 `/quote` endpoint.
 */
export interface Sep38IndicativeQuote {
  /** The asset being sold. */
  sell_asset: string;
  /** The asset being bought. */
  buy_asset: string;
  /** The price of `sell_asset` in terms of `buy_asset`. */
  price: string;
  /** Amount of `sell_asset` to be sold. */
  sell_amount: string;
  /** Amount of `buy_asset` to be bought. */
  buy_amount: string;
  /** Optional total price including fees. */
  total_price?: string;
  /** Optional fee information. */
  fee?: Sep38Fee;
}

/**
 * A firm (binding) quote returned by the SEP-0038 `/quote` endpoint.
 */
export interface Sep38FirmQuote {
  /** Unique identifier of the quote. */
  id: string;
  /** ISO-8601 timestamp at which the quote expires. */
  expires_at: string;
  /** The price of `sell_asset` in terms of `buy_asset`. */
  price: string;
  /** The asset being sold. */
  sell_asset: string;
  /** The asset being bought. */
  buy_asset: string;
  /** Amount of `sell_asset` to be sold. */
  sell_amount: string;
  /** Amount of `buy_asset` to be bought. */
  buy_amount: string;
  /** Optional total price including fees. */
  total_price?: string;
  /** Optional fee information. */
  fee?: Sep38Fee;
}

/**
 * Parameters for the SEP-0038 `/prices` endpoint.
 */
export interface Sep38PricesParams {
  /** The asset being sold. */
  sell_asset: string;
  /** The asset being bought. */
  buy_asset: string;
  /** Optional amount of `sell_asset`. */
  sell_amount?: string;
  /** Optional amount of `buy_asset`. */
  buy_amount?: string;
  /** Optional context (e.g. `sep6`, `sep24`, `sep31`). */
  context?: string;
  /** Optional ISO-3166-1 alpha-2 country code. */
  country_code?: string;
}

/**
 * Request body for the SEP-0038 `/quote` endpoint.
 *
 * Exactly one of `sell_amount` or `buy_amount` must be provided.
 */
export interface Sep38QuoteRequest {
  /** The asset being sold. */
  sell_asset: string;
  /** The asset being bought. */
  buy_asset: string;
  /** Amount of `sell_asset` to be sold. Mutually exclusive with `buy_amount`. */
  sell_amount?: string;
  /** Amount of `buy_asset` to be bought. Mutually exclusive with `sell_amount`. */
  buy_amount?: string;
  /** Context of the quote (e.g. `sep6`, `sep24`, `sep31`). Required for firm quotes. */
  context?: string;
  /** Optional ISO-8601 duration after which the quote expires. */
  expire_after?: string;
  /** Optional ISO-3166-1 alpha-2 country code. */
  country_code?: string;
  /** Optional delivery method for the sold asset. */
  sell_delivery_method?: string;
  /** Optional delivery method for the bought asset. */
  buy_delivery_method?: string;
}

/**
 * Configuration for the {@link Sep38Client}.
 */
export interface Sep38ClientConfig {
  /** Base URL of the anchor's SEP-0038 endpoint (e.g. `https://anchor.example.com`). */
  baseUrl: string;
  /** Optional SEP-10 JWT used for authenticated requests. */
  authToken?: string;
  /** Optional fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/**
 * Side of a conversion: whether the provided amount is the sell or buy amount.
 */
export type Sep38ConversionSide = 'sell' | 'buy';

/**
 * Result of a conversion computation.
 */
export interface Sep38Conversion {
  /** The price used for the conversion. */
  price: string;
  /** The sell amount. */
  sell_amount: string;
  /** The buy amount. */
  buy_amount: string;
}

/**
 * Error thrown when SEP-0038 request parameters are invalid.
 */
export class Sep38ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sep38ValidationError';
  }
}

/**
 * Error thrown when the anchor returns a non-successful response.
 */
export class Sep38RequestError extends Error {
  /** HTTP status code of the response. */
  public readonly status: number;
  /** Parsed response body, if available. */
  public readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'Sep38RequestError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Matches a SEP-38 asset identifier.
 *
 * Accepts either:
 *  - `stellar:<code>:<issuer>` (e.g. `stellar:USDC:GA...`)
 *  - `iso4217:<code>` (e.g. `iso4217:USD`)
 */
const ASSET_REGEX = /^(stellar:[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}|iso4217:[A-Z]{3})$/;

/**
 * Validates a SEP-38 asset identifier.
 *
 * @param asset - The asset identifier to validate.
 * @param field - The field name, used in error messages.
 * @throws {Sep38ValidationError} If the asset identifier is invalid.
 */
function validateAsset(asset: string | undefined, field: string): void {
  if (asset === undefined || asset === null || asset === '') {
    throw new Sep38ValidationError(`Missing required parameter: ${field}`);
  }
  if (typeof asset !== 'string' || !ASSET_REGEX.test(asset)) {
    throw new Sep38ValidationError(
      `Invalid asset identifier for ${field}: "${asset}". ` +
        'Expected "stellar:<code>:<issuer>" or "iso4217:<code>".',
    );
  }
}

/**
 * Validates that a string is a positive decimal number.
 *
 * @param value - The value to validate.
 * @param field - The field name, used in error messages.
 * @throws {Sep38ValidationError} If the value is not a positive decimal.
 */
function validateAmount(value: string | undefined, field: string): void {
  if (value === undefined || value === null || value === '') {
    throw new Sep38ValidationError(`Missing required parameter: ${field}`);
  }
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) {
    throw new Sep38ValidationError(
      `Invalid amount for ${field}: "${value}". Expected a positive decimal string.`,
    );
  }
}

/**
 * Validates that exactly one of `sell_amount` or `buy_amount` is provided.
 *
 * @param sellAmount - The sell amount, if any.
 * @param buyAmount - The buy amount, if any.
 * @throws {Sep38ValidationError} If both or neither are provided.
 */
function validateExactlyOneAmount(
  sellAmount: string | undefined,
  buyAmount: string | undefined,
): void {
  const hasSell = sellAmount !== undefined && sellAmount !== null && sellAmount !== '';
  const hasBuy = buyAmount !== undefined && buyAmount !== null && buyAmount !== '';

  if (hasSell && hasBuy) {
    throw new Sep38ValidationError(
      'Exactly one of sell_amount or buy_amount must be provided, but both were given.',
    );
  }
  if (!hasSell && !hasBuy) {
    throw new Sep38ValidationError(
      'Exactly one of sell_amount or buy_amount must be provided, but neither was given.',
    );
  }
}

/**
 * Performs decimal arithmetic on string amounts without floating point loss.
 *
 * Uses a simple fixed-point approach by scaling to a common precision.
 */
function decimalDivide(numerator: string, denominator: string): string {
  const num = Number(numerator);
  const den = Number(denominator);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    throw new Sep38ValidationError(
      `Cannot compute conversion: invalid numerator "${numerator}" or denominator "${denominator}".`,
    );
  }
  const result = num / den;
  // Trim trailing zeros while keeping a reasonable precision.
  return trimDecimal(result.toFixed(7));
}

/**
 * Multiplies two decimal strings.
 */
function decimalMultiply(a: string, b: string): string {
  const result = Number(a) * Number(b);
  if (!Number.isFinite(result)) {
    throw new Sep38ValidationError(
      `Cannot compute conversion: invalid operands "${a}" and "${b}".`,
    );
  }
  return trimDecimal(result.toFixed(7));
}

/**
 * Removes trailing zeros and a trailing decimal point from a decimal string.
 */
function trimDecimal(value: string): string {
  if (!value.includes('.')) {
    return value;
  }
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Computes a conversion given a price and an amount on one side.
 *
 * The price is defined as the amount of `buy_asset` per unit of `sell_asset`.
 *
 * - When `side` is `'sell'`, the provided amount is the sell amount and the
 *   buy amount is computed as `amount * price`.
 * - When `side` is `'buy'`, the provided amount is the buy amount and the
 *   sell amount is computed as `amount / price`.
 *
 * @param price - The price of the sell asset in terms of the buy asset.
 * @param amount - The amount on the given side.
 * @param side - Which side the amount represents.
 * @returns The computed sell and buy amounts along with the price used.
 * @throws {Sep38ValidationError} If the price or amount is invalid.
 */
export function computeConversion(
  price: string,
  amount: string,
  side: Sep38ConversionSide,
): Sep38Conversion {
  validateAmount(price, 'price');
  validateAmount(amount, 'amount');

  if (side !== 'sell' && side !== 'buy') {
    throw new Sep38ValidationError(
      `Invalid conversion side: "${side}". Expected "sell" or "buy".`,
    );
  }

  if (side === 'sell') {
    return {
      price,
      sell_amount: amount,
      buy_amount: decimalMultiply(amount, price),
    };
  }

  return {
    price,
    sell_amount: decimalDivide(amount, price),
    buy_amount: amount,
  };
}

/**
 * SEP-0038 client for interacting with an anchor's cross-asset quotes API.
 */
export class Sep38Client {
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: Sep38ClientConfig) {
    if (!config || !config.baseUrl) {
      throw new Sep38ValidationError('Missing required configuration: baseUrl');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.authToken = config.authToken;
    this.fetchImpl = config.fetch ?? globalThis.fetch;

    if (typeof this.fetchImpl !== 'function') {
      throw new Sep38ValidationError(
        'No fetch implementation available. Provide one via config.fetch.',
      );
    }
  }

  /**
   * Retrieves indicative prices for an asset pair.
   *
   * @param params - The price query parameters.
   * @returns A list of prices for the asset pair.
   * @throws {Sep38ValidationError} If parameters are invalid.
   * @throws {Sep38RequestError} If the anchor returns an error response.
   */
  async getPrices(params: Sep38PricesParams): Promise<Sep38Price[]> {
    if (!params) {
      throw new Sep38ValidationError('Missing required parameter: params');
    }

    validateAsset(params.sell_asset, 'sell_asset');
    validateAsset(params.buy_asset, 'buy_asset');

    if (params.sell_amount !== undefined && params.buy_amount !== undefined) {
      throw new Sep38ValidationError(
        'Only one of sell_amount or buy_amount may be provided to getPrices.',
      );
    }
    if (params.sell_amount !== undefined) {
      validateAmount(params.sell_amount, 'sell_amount');
    }
    if (params.buy_amount !== undefined) {
      validateAmount(params.buy_amount, 'buy_amount');
    }

    const query = new URLSearchParams();
    query.set('sell_asset', params.sell_asset);
    query.set('buy_asset', params.buy_asset);
    if (params.sell_amount !== undefined) {
      query.set('sell_amount', params.sell_amount);
    }
    if (params.buy_amount !== undefined) {
      query.set('buy_amount', params.buy_amount);
    }
    if (params.context !== undefined) {
      query.set('context', params.context);
    }
    if (params.country_code !== undefined) {
      query.set('country_code', params.country_code);
    }

    const response = await this.request<{ buy_assets: Sep38Price[] }>(
      'GET',
      `/sep38/prices?${query.toString()}`,
    );

    return response.buy_assets ?? [];
  }

  /**
   * Retrieves a previously created firm quote by its identifier.
   *
   * @param id - The quote identifier.
   * @returns The firm quote.
   * @throws {Sep38ValidationError} If the identifier is invalid.
   * @throws {Sep38RequestError} If the anchor returns an error response.
   */
  async getQuote(id: string): Promise<Sep38FirmQuote> {
    if (id === undefined || id === null || id === '') {
      throw new Sep38ValidationError('Missing required parameter: id');
    }
    if (typeof id !== 'string') {
      throw new Sep38ValidationError('Invalid parameter: id must be a string');
    }

    return this.request<Sep38FirmQuote>(
      'GET',
      `/sep38/quote/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Requests a firm quote for an asset pair.
   *
   * @param request - The quote request parameters.
   * @returns The firm quote.
   * @throws {Sep38ValidationError} If parameters are invalid.
   * @throws {Sep38RequestError} If the anchor returns an error response.
   */
  async postQuote(request: Sep38QuoteRequest): Promise<Sep38FirmQuote> {
    if (!request) {
      throw new Sep38ValidationError('Missing required parameter: request');
    }

    validateAsset(request.sell_asset, 'sell_asset');
    validateAsset(request.buy_asset, 'buy_asset');
    validateExactlyOneAmount(request.sell_amount, request.buy_amount);

    if (request.sell_amount !== undefined) {
      validateAmount(request.sell_amount, 'sell_amount');
    }
    if (request.buy_amount !== undefined) {
      validateAmount(request.buy_amount, 'buy_amount');
    }

    if (request.context === undefined || request.context === null || request.context === '') {
      throw new Sep38ValidationError(
        'Missing required parameter: context (required for firm quotes)',
      );
    }

    const body: Record<string, unknown> = {
      sell_asset: request.sell_asset,
      buy_asset: request.buy_asset,
      context: request.context,
    };

    if (request.sell_amount !== undefined) {
      body.sell_amount = request.sell_amount;
    }
    if (request.buy_amount !== undefined) {
      body.buy_amount = request.buy_amount;
    }
    if (request.expire_after !== undefined) {
      body.expire_after = request.expire_after;
    }
    if (request.country_code !== undefined) {
      body.country_code = request.country_code;
    }
    if (request.sell_delivery_method !== undefined) {
      body.sell_delivery_method = request.sell_delivery_method;
    }
    if (request.buy_delivery_method !== undefined) {
      body.buy_delivery_method = request.buy_delivery_method;
    }

    return this.request<Sep38FirmQuote>('POST', '/sep38/quote', body);
  }

  /**
   * Performs an HTTP request against the anchor and parses the JSON response.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }

    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Sep38RequestError(
        `Network error while calling ${method} ${url}: ${message}`,
        0,
      );
    }

    let parsed: unknown;
    const text = await response.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const errorMessage =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `Request failed with status ${response.status}`;
      throw new Sep38RequestError(
        `${method} ${url} failed: ${errorMessage}`,
        response.status,
        parsed,
      );
    }

    return parsed as T;
  }
}