import { defineConfig, devices } from "@playwright/test";

const HORIZON_URL = process.env.HORIZON_URL ?? "http://localhost:8000";
const RPC_URL = process.env.RPC_URL ?? "http://localhost:8000/soroban/rpc";

export default defineConfig({
  testDir: "./e2e/specs",
  timeout: 120000,
  expect: {
    timeout: 30000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        extraHTTPHeaders: {
          "X-Horizon-URL": HORIZON_URL,
          "X-RPC-URL": RPC_URL,
        },
      },
      metadata: {
        HORIZON_URL,
        RPC_URL,
      },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    command: "node e2e/setup/start-environment.js",
    port: 5173,
    reuseExistingServer: false,
    timeout: 300000,
    env: {
      HORIZON_URL,
      RPC_URL,
    },
  },
});