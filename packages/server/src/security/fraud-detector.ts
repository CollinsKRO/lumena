/**
 * Real-Time Anomaly and Fraud Detection Service
 *
 * Detects velocity spikes, rapid geo-IP shifts, and unusual destination
 * patterns for wallet transactions. Produces a risk score and, when a
 * velocity anomaly exceeds the configured threshold, a policy violation
 * with code `FRAUD_VELOCITY_TRIGGERED`.
 */

export const FRAUD_VELOCITY_TRIGGERED = 'FRAUD_VELOCITY_TRIGGERED';

export interface FraudDetectorConfig {
  /** Risk score (0-100) at or above which a transaction is rejected. */
  maxRiskScore: number;
  /** Multiplier over rolling baseline volume that counts as a velocity spike. */
  velocityMultiplier: number;
  /** Window (ms) used to compute the rolling baseline volume. */
  baselineWindowMs: number;
  /** Window (ms) within which a distant geo-IP shift is considered suspicious. */
  geoShiftWindowMs: number;
  /** Minimum distance (km) between countries to count as a geo shift. */
  geoShiftMinDistanceKm: number;
  /** Number of recent destinations considered for "unusual destination" checks. */
  destinationHistorySize: number;
  /** Risk contribution weights. */
  weights: {
    velocity: number;
    geoShift: number;
    unusualDestination: number;
  };
}

export const DEFAULT_CONFIG: FraudDetectorConfig = {
  maxRiskScore: 70,
  velocityMultiplier: 10,
  baselineWindowMs: 24 * 60 * 60 * 1000, // 24h
  geoShiftWindowMs: 60 * 60 * 1000, // 1h
  geoShiftMinDistanceKm: 500,
  destinationHistorySize: 20,
  weights: {
    velocity: 60,
    geoShift: 40,
    unusualDestination: 30,
  },
};

export interface GeoLocation {
  ip: string;
  country: string;
  /** Optional latitude in degrees. */
  latitude?: number;
  /** Optional longitude in degrees. */
  longitude?: number;
}

export interface FraudScoreInput {
  walletId: string;
  /** Transaction volume (e.g. amount in stroops or base units). */
  volume: number;
  /** Destination address. */
  destination: string;
  /** Timestamp of the transaction (ms since epoch). Defaults to Date.now(). */
  timestamp?: number;
  /** Geo-IP information for the request. */
  geo?: GeoLocation;
}

export interface PolicyViolation {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface FraudScoreResult {
  riskScore: number;
  flags: string[];
  reject: boolean;
  violations: PolicyViolation[];
}

interface HistoryEntry {
  volume: number;
  timestamp: number;
  destination: string;
  geo?: GeoLocation;
}

interface WalletHistory {
  entries: HistoryEntry[];
}

/** Approximate country centroids used when lat/long are not provided. */
const COUNTRY_CENTROIDS: Record<string, { lat: number; lon: number }> = {
  US: { lat: 39.5, lon: -98.35 },
  CA: { lat: 56.13, lon: -106.35 },
  MX: { lat: 23.63, lon: -102.55 },
  BR: { lat: -14.24, lon: -51.93 },
  AR: { lat: -38.42, lon: -63.62 },
  GB: { lat: 55.38, lon: -3.44 },
  DE: { lat: 51.17, lon: 10.45 },
  FR: { lat: 46.23, lon: 2.21 },
  ES: { lat: 40.46, lon: -3.75 },
  IT: { lat: 41.87, lon: 12.57 },
  NL: { lat: 52.13, lon: 5.29 },
  RU: { lat: 61.52, lon: 105.32 },
  CN: { lat: 35.86, lon: 104.2 },
  JP: { lat: 36.2, lon: 138.25 },
  KR: { lat: 35.91, lon: 127.77 },
  IN: { lat: 20.59, lon: 78.96 },
  SG: { lat: 1.35, lon: 103.82 },
  AU: { lat: -25.27, lon: 133.78 },
  NZ: { lat: -40.9, lon: 174.89 },
  ZA: { lat: -30.56, lon: 22.94 },
  NG: { lat: 9.08, lon: 8.68 },
  EG: { lat: 26.82, lon: 30.8 },
  AE: { lat: 23.42, lon: 53.85 },
  TR: { lat: 38.96, lon: 35.24 },
  SE: { lat: 60.13, lon: 18.64 },
  NO: { lat: 60.47, lon: 8.47 },
  PL: { lat: 51.92, lon: 19.15 },
  UA: { lat: 48.38, lon: 31.17 },
};

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Haversine distance in kilometers. */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function resolveCoords(
  geo: GeoLocation,
): { lat: number; lon: number } | undefined {
  if (typeof geo.latitude === 'number' && typeof geo.longitude === 'number') {
    return { lat: geo.latitude, lon: geo.longitude };
  }
  const centroid = COUNTRY_CENTROIDS[geo.country?.toUpperCase()];
  if (centroid) {
    return { lat: centroid.lat, lon: centroid.lon };
  }
  return undefined;
}

export class FraudDetector {
  private readonly config: FraudDetectorConfig;
  private readonly histories = new Map<string, WalletHistory>();

  constructor(config: Partial<FraudDetectorConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      weights: {
        ...DEFAULT_CONFIG.weights,
        ...(config.weights ?? {}),
      },
    };
  }

  getConfig(): FraudDetectorConfig {
    return { ...this.config, weights: { ...this.config.weights } };
  }

  /** Clears history for a wallet (or all wallets if omitted). */
  reset(walletId?: string): void {
    if (walletId) {
      this.histories.delete(walletId);
    } else {
      this.histories.clear();
    }
  }

  /**
   * Scores a transaction and returns the risk assessment. Does not mutate
   * history; call `record` (or use `scoreAndRecord`) to persist the entry.
   */
  score(input: FraudScoreInput): FraudScoreResult {
    const timestamp = input.timestamp ?? Date.now();
    const history = this.histories.get(input.walletId);
    const entries = history?.entries ?? [];

    const flags: string[] = [];
    const violations: PolicyViolation[] = [];
    let riskScore = 0;

    // --- Velocity check ---------------------------------------------------
    const baselineEntries = entries.filter(
      (e) => timestamp - e.timestamp <= this.config.baselineWindowMs,
    );
    const baselineVolume = baselineEntries.reduce((sum, e) => sum + e.volume, 0);
    const baselineAvg =
      baselineEntries.length > 0 ? baselineVolume / baselineEntries.length : 0;

    let velocityTriggered = false;
    if (baselineAvg > 0) {
      const ratio = input.volume / baselineAvg;
      if (ratio >= this.config.velocityMultiplier) {
        velocityTriggered = true;
        flags.push('VELOCITY_SPIKE');
        riskScore += this.config.weights.velocity;
      } else if (ratio >= this.config.velocityMultiplier / 2) {
        flags.push('VELOCITY_ELEVATED');
        riskScore += this.config.weights.velocity / 2;
      }
    }

    if (velocityTriggered) {
      violations.push({
        code: FRAUD_VELOCITY_TRIGGERED,
        message: `Transaction volume ${input.volume} exceeds ${this.config.velocityMultiplier}x rolling baseline (${baselineAvg.toFixed(2)}).`,
        details: {
          volume: input.volume,
          baselineAvg,
          multiplier: this.config.velocityMultiplier,
          ratio: baselineAvg > 0 ? input.volume / baselineAvg : null,
        },
      });
    }

    // --- Geo-IP shift check ----------------------------------------------
    if (input.geo) {
      const currentCoords = resolveCoords(input.geo);
      const recentGeoEntries = entries
        .filter(
          (e) =>
            e.geo &&
            timestamp - e.timestamp <= this.config.geoShiftWindowMs &&
            timestamp - e.timestamp >= 0,
        )
        .sort((a, b) => b.timestamp - a.timestamp);

      for (const prev of recentGeoEntries) {
        const prevGeo = prev.geo as GeoLocation;
        if (prevGeo.country?.toUpperCase() === input.geo.country?.toUpperCase()) {
          continue;
        }
        const prevCoords = resolveCoords(prevGeo);
        if (!currentCoords || !prevCoords) {
          // Different countries within window but unknown distance: flag lightly.
          flags.push('GEO_SHIFT');
          riskScore += this.config.weights.geoShift / 2;
          break;
        }
        const distance = haversineKm(
          prevCoords.lat,
          prevCoords.lon,
          currentCoords.lat,
          currentCoords.lon,
        );
        if (distance >= this.config.geoShiftMinDistanceKm) {
          flags.push('GEO_SHIFT');
          riskScore += this.config.weights.geoShift;
          break;
        }
      }
    }

    // --- Unusual destination check ---------------------------------------
    const recentDestinations = entries
      .slice(-this.config.destinationHistorySize)
      .map((e) => e.destination);
    if (
      recentDestinations.length > 0 &&
      !recentDestinations.includes(input.destination)
    ) {
      flags.push('UNUSUAL_DESTINATION');
      riskScore += this.config.weights.unusualDestination;
    }

    riskScore = Math.min(100, Math.max(0, riskScore));
    const reject = riskScore >= this.config.maxRiskScore;

    return { riskScore, flags, reject, violations };
  }

  /** Records a transaction into the wallet's history. */
  record(input: FraudScoreInput): void {
    const timestamp = input.timestamp ?? Date.now();
    let history = this.histories.get(input.walletId);
    if (!history) {
      history = { entries: [] };
      this.histories.set(input.walletId, history);
    }
    history.entries.push({
      volume: input.volume,
      timestamp,
      destination: input.destination,
      geo: input.geo,
    });
    // Trim entries older than the largest window we care about.
    const maxWindow = Math.max(
      this.config.baselineWindowMs,
      this.config.geoShiftWindowMs,
    );
    const cutoff = timestamp - maxWindow;
    history.entries = history.entries.filter((e) => e.timestamp >= cutoff);
  }

  /** Scores and records the transaction in one call. */
  scoreAndRecord(input: FraudScoreInput): FraudScoreResult {
    const result = this.score(input);
    this.record(input);
    return result;
  }
}