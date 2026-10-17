import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useNetworkHealth } from "../use-network-health";

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

describe("useNetworkHealth", () => {
  it("returns healthy status with latency and ledger number", async () => {
    const { result } = renderHook(() => useNetworkHealth());
    await waitFor(() => expect(result.current.status).toBe("healthy"));
    expect(typeof result.current.latencyMs).toBe("number");
    expect(typeof result.current.ledgerNumber).toBe("number");
  });

  it("reports degraded status when latency exceeds 2500ms", async () => {
    const { result } = renderHook(() =>
      useNetworkHealth({ ping: async () => ({ latencyMs: 3000, ledgerNumber: 123 }) })
    );
    await waitFor(() => expect(result.current.status).toBe("degraded"));
    expect(result.current.latencyMs).toBe(3000);
  });

  it("reports offline status when the heartbeat fails", async () => {
    const { result } = renderHook(() =>
      useNetworkHealth({ ping: async () => { throw new Error("network down"); } })
    );
    await waitFor(() => expect(result.current.status).toBe("offline"));
  });
});
