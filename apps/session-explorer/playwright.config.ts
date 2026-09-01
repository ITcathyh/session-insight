import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const appDir = fileURLToPath(new URL(".", import.meta.url));
const port = process.env.SESSION_EXPLORER_E2E_PORT ?? "4792";
const data = process.env.SESSION_EXPLORER_E2E_DATA ?? join(tmpdir(), "session-explorer-e2e", "index.json");

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: `rm -f ${JSON.stringify(data)} && SESSION_EXPLORER_ADDR=127.0.0.1:${port} SESSION_EXPLORER_DATA=${JSON.stringify(data)} pnpm explorer`,
    cwd: join(appDir, "../.."),
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
