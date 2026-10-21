import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LumenClient } from "@lumen/web-sdk";
import { LumenProvider } from "./context.js";
import { useSocialRecovery } from "./use-social-recovery.js";
import type { RecoveryRequest } from "./use-social-recovery.js";

describe("useSocialRecovery HTTP methods", () => {
  const walletId = "wallet/private?owner=1";
  const newPublicKey = "new+public&key";
  const recoveryId = "request/1?private=true";
  const pending: RecoveryRequest = {
    id: recoveryId,
    walletId,
    newPublicKey,
    approvals: 0,
    threshold: 2,
    timelockEndsAt: null,
    state: "pending",
  };
  const post = vi.fn();
  const get = vi.fn();
  const client = { post, get } as unknown as LumenClient;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <LumenProvider client={client}>{children}</LumenProvider>
  );
  const setup = () => renderHook(() => useSocialRecovery(walletId), { wrapper });

  beforeEach(() => {
    vi.useFakeTimers();
    post.mockReset().mockResolvedValue(pending);
    get.mockReset().mockResolvedValue(pending);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("initiates with wallet data in the POST body and keeps status polling read-only", async () => {
    const { result } = setup();
    await act(() => result.current.initiateRecovery(newPublicKey));

    expect(post).toHaveBeenCalledExactlyOnceWith("/recovery/initiate", { walletId, newPublicKey });
    expect(get).not.toHaveBeenCalled();
    expect(result.current.recovery).toEqual(pending);
    expect(result.current.recoveryStatus).toBe("initiated");

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(get).toHaveBeenCalledExactlyOnceWith(`/recovery/${encodeURIComponent(recoveryId)}`);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("approves using POST with an encoded path and the original recovery ID in the body", async () => {
    const approved = { ...pending, approvals: 2 };
    post.mockResolvedValue(approved);
    const { result } = setup();
    await act(() => result.current.approveRecovery(recoveryId));

    expect(post).toHaveBeenCalledExactlyOnceWith(
      `/recovery/${encodeURIComponent(recoveryId)}/approve`,
      { recoveryId },
    );
    expect(get).not.toHaveBeenCalled();
    expect(result.current.approvals).toBe(2);
    expect(result.current.recoveryStatus).toBe("guardian-approved");
  });

  it("cancels using a bodyless POST and stops polling", async () => {
    const { result } = setup();
    await act(() => result.current.initiateRecovery(newPublicKey));
    post.mockClear().mockResolvedValue({ ...pending, state: "cancelled" });
    await act(() => result.current.cancelRecovery());

    expect(post).toHaveBeenCalledExactlyOnceWith(
      `/recovery/${encodeURIComponent(recoveryId)}/cancel`,
    );
    expect(result.current.recoveryStatus).toBe("cancelled");
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(get).not.toHaveBeenCalled();
  });

  it.each(["initiate", "approve", "cancel"])(
    "reports %s POST failures without falling back to GET",
    async (operation) => {
      const { result } = setup();
      if (operation === "cancel") {
        await act(() => result.current.initiateRecovery(newPublicKey));
      }
      const error = new Error("Recovery denied");
      post.mockRejectedValue(error);
      await act(async () => {
        if (operation === "initiate") await result.current.initiateRecovery(newPublicKey);
        else if (operation === "approve") await result.current.approveRecovery(recoveryId);
        else await result.current.cancelRecovery();
      });
      expect(result.current.error).toBe(error);
      expect(result.current.recoveryStatus).toBe("error");
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(get).not.toHaveBeenCalled();
    },
  );
});
