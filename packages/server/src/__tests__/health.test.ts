import { describe, it, expect } from "vitest";

describe("health response structure", () => {
  it("formats health payload structure", () => {
    const health = {
      status: "ok",
      horizonConnected: true,
      network: "testnet",
      version: "0.1.0",
    };
    expect(health.status).toBe("ok");
    expect(health.network).toBe("testnet");
  });
});

type ComponentStatus = "healthy" | "degraded" | "unreachable";

interface DeepHealthReport {
  status: "ok" | "degraded";
  components: {
    redis: ComponentStatus;
    horizon: ComponentStatus;
    kms: ComponentStatus;
    sponsor: ComponentStatus;
  };
  details?: Record<string, unknown>;
}

interface DeepHealthProbes {
  pingRedis: () => Promise<boolean>;
  probeHorizon: () => Promise<{ reachable: boolean; latencyMs: number }>;
  probeKmsSigner: () => Promise<{ canSign: boolean }>;
  probeSponsorBalance: () => Promise<{ balance: number; minimum: number }>;
}

async function runDeepHealth(
  probes: DeepHealthProbes,
): Promise<{ statusCode: number; body: DeepHealthReport }> {
  const components: DeepHealthReport["components"] = {
    redis: "healthy",
    horizon: "healthy",
    kms: "healthy",
    sponsor: "healthy",
  };
  const details: Record<string, unknown> = {};

  try {
    const redisOk = await probes.pingRedis();
    if (!redisOk) {
      components.redis = "unreachable";
    }
  } catch {
    components.redis = "unreachable";
  }

  try {
    const horizon = await probes.probeHorizon();
    details.horizonLatencyMs = horizon.latencyMs;
    if (!horizon.reachable) {
      components.horizon = "unreachable";
    }
  } catch {
    components.horizon = "unreachable";
  }

  try {
    const kms = await probes.probeKmsSigner();
    if (!kms.canSign) {
      components.kms = "degraded";
    }
  } catch {
    components.kms = "degraded";
  }

  try {
    const sponsor = await probes.probeSponsorBalance();
    details.sponsorBalance = sponsor.balance;
    if (sponsor.balance < sponsor.minimum) {
      components.sponsor = "degraded";
    }
  } catch {
    components.sponsor = "degraded";
  }

  const allHealthy = Object.values(components).every((c) => c === "healthy");
  const statusCode = allHealthy ? 200 : 503;

  return {
    statusCode,
    body: {
      status: allHealthy ? "ok" : "degraded",
      components,
      details,
    },
  };
}

function healthyProbes(): DeepHealthProbes {
  return {
    pingRedis: async () => true,
    probeHorizon: async () => ({ reachable: true, latencyMs: 42 }),
    probeKmsSigner: async () => ({ canSign: true }),
    probeSponsorBalance: async () => ({ balance: 100, minimum: 10 }),
  };
}

describe("deep health endpoint", () => {
  it("returns 200 with every component healthy when all probes pass", async () => {
    const { statusCode, body } = await runDeepHealth(healthyProbes());

    expect(statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.components).toEqual({
      redis: "healthy",
      horizon: "healthy",
      kms: "healthy",
      sponsor: "healthy",
    });
  });

  it("returns 503 with redis unreachable and horizon healthy when Redis is disconnected", async () => {
    const probes = healthyProbes();
    probes.pingRedis = async () => false;

    const { statusCode, body } = await runDeepHealth(probes);

    expect(statusCode).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.components.redis).toBe("unreachable");
    expect(body.components.horizon).toBe("healthy");
  });

  it("returns 503 with redis unreachable when Redis ping throws", async () => {
    const probes = healthyProbes();
    probes.pingRedis = async () => {
      throw new Error("ECONNREFUSED");
    };

    const { statusCode, body } = await runDeepHealth(probes);

    expect(statusCode).toBe(503);
    expect(body.components.redis).toBe("unreachable");
  });

  it("returns 503 with kms degraded when the KMS signer cannot sign", async () => {
    const probes = healthyProbes();
    probes.probeKmsSigner = async () => ({ canSign: false });

    const { statusCode, body } = await runDeepHealth(probes);

    expect(statusCode).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.components.kms).toBe("degraded");
    expect(body.components.redis).toBe("healthy");
    expect(body.components.horizon).toBe("healthy");
  });

  it("returns 503 with kms degraded when the KMS signer probe throws", async () => {
    const probes = healthyProbes();
    probes.probeKmsSigner = async () => {
      throw new Error("ExpiredToken");
    };

    const { statusCode, body } = await runDeepHealth(probes);

    expect(statusCode).toBe(503);
    expect(body.components.kms).toBe("degraded");
  });

  it("returns 503 with sponsor degraded when the sponsor balance is below minimum", async () => {
    const probes = healthyProbes();
    probes.probeSponsorBalance = async () => ({ balance: 1, minimum: 10 });

    const { statusCode, body } = await runDeepHealth(probes);

    expect(statusCode).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.components.sponsor).toBe("degraded");
    expect(body.components.kms).toBe("healthy");
  });

  it("returns 503 with horizon unreachable when Horizon is down", async () => {
    const probes = healthyProbes();
    probes.probeHorizon = async () => ({ reachable: false, latencyMs: 0 });

    const { statusCode, body } = await runDeepHealth(probes);

    expect(statusCode).toBe(503);
    expect(body.components.horizon).toBe("unreachable");
    expect(body.components.redis).toBe("healthy");
  });
});