import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LumenSwapWidget } from "./components/LumenSwapWidget.js";

describe("LumenSwapWidget", () => {
  it("renders the quote details and forwards the input changes", () => {
    const onSwap = vi.fn();
    const onFromAmountChange = vi.fn();
    const onToAmountChange = vi.fn();

    render(
      <LumenSwapWidget
        fromAsset="XLM"
        toAsset="USDC"
        fromAmount="100"
        toAmount="12.5"
        slippage={0.5}
        loading={false}
        disabled={false}
        onSwap={onSwap}
        onFromAmountChange={onFromAmountChange}
        onToAmountChange={onToAmountChange}
      />,
    );

    const fromInput = screen.getByLabelText("You pay");
    const toInput = screen.getByLabelText("You receive");

    fireEvent.change(fromInput, { target: { value: "250" } });
    fireEvent.change(toInput, { target: { value: "31.25" } });

    expect(onFromAmountChange).toHaveBeenCalledWith("250");
    expect(onToAmountChange).toHaveBeenCalledWith("31.25");

    expect(screen.getByText("Slippage"));
    expect(screen.getByText("0.5%"));
    expect(screen.getByText("Estimated price")).not.toBeNull();
    expect(screen.getByText("Minimum received")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /swap/i }));
    expect(onSwap).toHaveBeenCalledTimes(1);
  });

  it("disables the form while loading", () => {
    render(
      <LumenSwapWidget
        fromAsset="XLM"
        toAsset="USDC"
        fromAmount="100"
        toAmount="12.5"
        slippage={0.5}
        loading
        disabled={false}
        onSwap={vi.fn()}
        onFromAmountChange={vi.fn()}
        onToAmountChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /swapping/i })).toBeDisabled();
  });

  it("disables the form while disabled", () => {
    render(
      <LumenSwapWidget
        fromAsset="XLM"
        toAsset="USDC"
        fromAmount="100"
        toAmount="12.5"
        slippage={0.5}
        loading={false}
        disabled
        onSwap={vi.fn()}
        onFromAmountChange={vi.fn()}
        onToAmountChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /swap/i })).toBeDisabled();
  });
});
