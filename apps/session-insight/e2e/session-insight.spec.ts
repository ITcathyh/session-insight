import { expect, test } from "@playwright/test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  CODEX_CONTEXT_PEAK_LABEL,
  CODEX_SESSION_ID,
  CODEX_TRACE_EVENTS,
  CODEX_TRACKED_TOKENS_LABEL,
  CODEX_USER_TURNS,
  CODEX_AGENT_TURNS,
  codexSessionUpload,
} from "./fixtures";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const claudeDirectory = join(
  root,
  "server/internal/sessioninsight/testdata/claude/projects/demo",
);
const traexDirectory = join(
  root,
  "server/internal/sessioninsight/testdata/traex",
);
const paginationFixture = readFileSync(
  join(
    root,
    "server/internal/sessioninsight/testdata/codex/sessions/2026/08/30/modern.jsonl",
  ),
  "utf8",
);
const sessionID = CODEX_SESSION_ID;
const testDataDir = join(tmpdir(), "session-insight-e2e");
const index =
  process.env.SESSION_INSIGHT_E2E_DATA ?? join(testDataDir, "index.json");

test.afterAll(() => {
  if (!process.env.SESSION_INSIGHT_E2E_DATA)
    rmSync(testDataDir, { recursive: true, force: true });
  else rmSync(index, { force: true });
});

function generatedSessions() {
  return Array.from({ length: 51 }, (_, index) => ({
    name: `e2e-pagination-${index}.jsonl`,
    mimeType: "application/json",
    buffer: Buffer.from(
      paginationFixture.replace("codex-modern-root", `e2e-pagination-${index}`),
    ),
  }));
}

function crossDaySession() {
  return {
    name: "e2e-cross-day.jsonl",
    mimeType: "application/json",
    buffer: Buffer.from(
      paginationFixture
        .replace(/2026-08-(20|29|30)/g, "2026-09-02")
        .replace("codex-modern-root", "e2e-cross-day"),
    ),
  };
}

async function expectInViewport(locator: import("@playwright/test").Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const viewport = await locator.evaluate(() => ({
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
    scale: window.visualViewport?.scale ?? 1,
  }));
  expect(box).not.toBeNull();
  expect(viewport.scale).toBe(1);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

test("ships an inspectable Codex, Claude, and TraeX session workbench", async ({
  page,
  context,
}) => {
  const consoleErrors: string[] = [];
  const apiFailures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400)
      apiFailures.push(`${response.status()} ${response.url()}`);
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  // A row is headlined by its derived title now, so a raw session id proves
  // reachable through search instead of by being printed in the row.
  const expectFindable = async (query: string, rows: number) => {
    const search = page.getByTestId("search-input");
    await search.fill(query);
    await expect(page.locator("tbody tr")).toHaveCount(rows);
    await search.fill("");
  };

  await expect(page.getByText("0 个 session")).toBeVisible();
  await page
    .locator("main")
    .getByTestId("file-input")
    .setInputFiles(codexSessionUpload());
  await expectFindable(sessionID, 1);
  await page.locator(".top-import summary").click();
  await page
    .locator(".top-import")
    .getByTestId("directory-input")
    .setInputFiles(claudeDirectory);
  await expectFindable("claude-root", 2);
  await page
    .locator(".top-import")
    .getByTestId("directory-input")
    .setInputFiles(traexDirectory);
  await expectFindable("traex-modern-root", 1);
  // The TraeX fixture opens with "inspect the project"; that line is what the
  // library shows, and searching its text alone must find the run.
  await expectFindable("inspect the project", 1);
  await expect(
    page.getByRole("row").filter({ hasText: "inspect the project" }),
  ).toHaveCount(1);
  const listed = (await page.evaluate(() =>
    fetch("/api/session-insights/runs?limit=10").then((response) =>
      response.json(),
    ),
  )) as {
    runs: Array<{
      id: string;
      provider?: string;
      runKind?: string;
      counts?: { tools?: number; toolFailures?: number };
      model?: string;
      sourceSessionId?: string;
    }>;
  };
  const codexEvidence = listed.runs.find(
    (run) => run.sourceSessionId === sessionID,
  );
  expect(codexEvidence).toBeDefined();
  const codexRun = codexEvidence!.id;
  const claudeEvidence = listed.runs.find(
    (run) =>
      run.provider === "claude" &&
      run.runKind === "main" &&
      run.counts?.tools === 2 &&
      run.counts.toolFailures === 1,
  );
  expect(claudeEvidence).toBeDefined();
  const claudeRun = claudeEvidence!.id;
  const traexEvidence = listed.runs.find(
    (run) => run.provider === "traex" && run.model === "traex-test",
  );
  expect(traexEvidence).toBeDefined();
  const traexRun = traexEvidence!.id;

  const claudeDetail = (await page.evaluate((runID) =>
    fetch(`/api/session-insights/runs/${runID}`).then((response) =>
      response.json(),
    ), claudeRun)) as {
    model?: string;
    trace?: Array<{ name?: string; output?: string }>;
  };
  expect(claudeDetail.model).toBe("claude-test");
  expect(claudeDetail.trace?.some((event) => event.name === "Reasoning")).toBe(
    true,
  );
  expect(
    claudeDetail.trace?.some(
      (event) =>
        event.name === "Agent response" &&
        event.output === "Claude fixture response",
    ),
  ).toBe(true);

  const traexDetail = (await page.evaluate((runID) =>
    fetch(`/api/session-insights/runs/${runID}`).then((response) =>
      response.json(),
    ), traexRun)) as {
    provider?: string;
    trace?: Array<{ name?: string; output?: string; type?: string }>;
  };
  expect(traexDetail.provider).toBe("traex");
  for (const behavior of [
    "User message",
    "Reasoning",
    "Agent response",
    "exec_command",
    "Subagent started",
  ]) {
    expect(traexDetail.trace?.some((event) => event.name === behavior)).toBe(
      true,
    );
  }

  await page.goto(`/sessions/${claudeRun}`);
  await page.getByRole("button", { name: "对话" }).click();
  await expect(page.locator(".conversation-view li.user")).toHaveCount(1);
  await expect(page.locator(".conversation-view li.model")).toHaveCount(1);
  await expect(page.locator(".conversation-view")).toContainText(
    "Claude fixture response",
  );
  await expect(page.locator(".conversation-view")).not.toContainText(
    "内容摘要不可用",
  );

  await page.goto(`/sessions/${traexRun}`);
  await page.getByRole("button", { name: "对话" }).click();
  await expect(page.locator(".conversation-view li.user")).toHaveCount(1);
  await expect(page.locator(".conversation-view li.model")).toHaveCount(1);
  await expect(page.locator(".conversation-view")).toContainText("tests passed");
  await expect(page.locator(".conversation-view")).not.toContainText(
    "内容摘要不可用",
  );

  await page.goto("/");

  await page.getByTestId("search-input").fill(sessionID);
  const targetRow = page.locator("tbody tr");
  await expect(targetRow).toHaveCount(1);
  await targetRow.getByRole("link").click();
  await expect(page).toHaveURL(/\/sessions\//);
  const codexTraceUrl = page.url();
  await expect(page.getByTestId("session-detail")).toContainText(
    CODEX_TRACKED_TOKENS_LABEL,
  );
  // Three risk classes: tool failures, context peak >= 80%, and a correction.
  await expect(
    page.getByRole("heading", { name: "3 类信号需要检查" }),
  ).toBeVisible();
  const contextPeak = page
    .locator(".session-summary > div")
    .filter({ hasText: "上下文峰值" });
  await expect(contextPeak).toContainText(CODEX_CONTEXT_PEAK_LABEL);
  await expect(contextPeak).not.toContainText("不可用");
  await page.getByRole("button", { name: /时间轴/ }).click();
  await expectInViewport(page.getByTestId("compressed-time"));
  await expectInViewport(page.getByTestId("real-time"));
  await expectInViewport(page.getByTestId("trace-inspector"));
  await page.keyboard.press("Meta+f");
  await expect(page.getByRole("searchbox", { name: "搜索事件" })).toBeFocused();
  await page.getByRole("searchbox", { name: "搜索事件" }).fill("command_execution");
  await expect(page).toHaveURL(/event=command_execution/);
  await page.getByRole("searchbox", { name: "搜索事件" }).fill("");
  const focusedFailure = new URL(page.url()).searchParams.get("focus");
  await page.keyboard.press("F8");
  await expect.poll(() => new URL(page.url()).searchParams.get("focus")).not.toBe(focusedFailure);

  const inspector = page.getByTestId("trace-inspector");
  await expect(inspector).not.toContainText("选择树、waterfall");
  const evidenceTimeline = page.getByRole("slider", { name: /执行证据时间轴/ });
  const cursorBefore = await evidenceTimeline.getAttribute("aria-valuenow");
  await evidenceTimeline.hover({ position: { x: 500, y: 120 } });
  await expect
    .poll(() => evidenceTimeline.getAttribute("aria-valuenow"))
    .not.toBe(cursorBefore);
  await page.getByTestId("real-time").click();
  await expect(page.getByTestId("real-time")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page).toHaveURL(/time=real/);
  await page.getByTestId("compressed-time").click();
  await expect(page.getByTestId("compressed-time")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page).not.toHaveURL(/time=real/);

  expect(await page.getByRole("treeitem").count()).toBeLessThan(80);
  // Telemetry markers are excluded from the event list, so the denominator is
  // the signal count and the folded pulses are reported separately.
  const timelineStatus = page.locator(".timeline-status").first();
  await expect(timelineStatus).toContainText(/显示 \d+ \/ \d+ 个事件/);
  await expect(timelineStatus).toContainText(/另有 \d+ 个遥测事件未列出/);
  const [shown, ofSignals, folded] = (
    (await timelineStatus.textContent()) ?? ""
  )
    .match(/显示 (\d+) \/ (\d+) 个事件（另有 (\d+) 个遥测事件未列出）/)!
    .slice(1)
    .map(Number);
  expect(shown).toBeLessThan(ofSignals);
  // Nothing is silently dropped: signals plus folded telemetry is the whole run.
  expect(ofSignals + folded).toBe(CODEX_TRACE_EVENTS);
  const disclosure = page.locator(".tree-disclosure").first();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  const child = page.getByRole("treeitem").nth(1);
  await child.click();
  await inspector.getByRole("tab", { name: "关联" }).click();
  await expect(inspector.getByText("父事件")).toBeVisible();

  const allTreeItems = await page.getByRole("treeitem").count();
  await page.getByLabel("事件类型").selectOption("tool");
  expect(await page.getByRole("treeitem").count()).toBeLessThanOrEqual(
    allTreeItems,
  );
  await expect(page.locator(".virtual-tree-item .dot.tool")).toHaveCount(
    await page.getByRole("treeitem").count(),
  );
  await page.getByRole("button", { name: "仅失败" }).click();
  await expect(page.getByRole("treeitem")).not.toHaveCount(0);
  await page.getByRole("button", { name: "对话" }).click();
  await expect(page.getByRole("heading", { name: "对话" })).toBeVisible();
  await expect(page.locator(".conversation-view li.user")).toHaveCount(
    CODEX_USER_TURNS,
  );
  await expect(page.locator(".conversation-view li.model")).toHaveCount(
    CODEX_AGENT_TURNS,
  );
  await page.getByRole("button", { name: "在时间轴定位 →" }).first().click();
  await expect(
    page.locator(".session-tabs").getByRole("button", { name: /时间轴/ }),
  ).toHaveAttribute("aria-current", "page");

  await page.getByRole("link", { name: "返回会话库" }).click();
  await page.getByTestId("search-input").fill("");
  await page
    .getByRole("row")
    .filter({ has: page.getByTestId(`session-${codexRun}`) })
    .getByRole("checkbox")
    .check();
  await page
    .getByRole("row")
    .filter({ has: page.getByTestId(`session-${claudeRun}`) })
    .getByRole("checkbox")
    .check();
  await page.getByRole("button", { name: "对比已选 2 条" }).click();
  await expect(page.getByRole("heading", { name: / vs / })).toBeVisible();
  await expect(page.locator(".compare-lane")).toHaveCount(2);
  const lane = page.locator(".compare-lane").first();
  await page.getByRole("button", { name: "标准化时间" }).click();
  await expect(
    page.getByRole("button", { name: "共同真实时间" }),
  ).toBeVisible();
  await expect(lane).toContainText("共同真实时间");
  const tokenPosition = await lane
    .getByTestId("compare-token-pulse")
    .locator("[data-timeline-position]")
    .first()
    .getAttribute("data-timeline-position");
  await expect(
    lane
      .locator(`.compare-bars [data-timeline-position="${tokenPosition}"]`)
      .first(),
  ).toBeVisible();
  await expect(page.getByText("总耗时 Δ").locator("..")).toContainText(
    /[+−]\d+(ms|s|m|h|d)/,
  );
  await page
    .locator(".difference tbody tr")
    .first()
    .getByRole("button")
    .click();
  await expect(page.getByText(/已同步筛选：.*已高亮双方证据/)).toBeVisible();
  const unobservedDifference = page
    .locator(".difference tbody tr")
    .filter({ hasText: "未观测" })
    .first();
  await expect(unobservedDifference).toBeVisible();
  await expect(unobservedDifference.locator("td").last()).toHaveText("—");
  const bashDifference = page
    .locator(".difference tbody tr")
    .filter({ hasText: /bash/i });
  await expect(bashDifference).toBeVisible();
  await expect(bashDifference).toContainText("1");

  await page.goto(`/report?run=${claudeRun}`);
  await expect(page).toHaveURL(/\/report\?run=/);
  await expect(
    page.getByRole("heading", { name: "Session 分析报告" }),
  ).toBeVisible();
  await expect(page.getByTestId("report-evidence-link").first()).toBeVisible();
  await expectInViewport(page.locator(".report-actions"));
  await expectInViewport(page.locator(".report-actions > *").last());
  await expectInViewport(page.getByTestId("report-evidence-link").first());
  await expect(page.getByText("工具 / 失败").locator("..")).toContainText(
    "2 / 1",
  );
  await page.getByRole("button", { name: "复制 Markdown" }).click();
  await expect(page.getByRole("button", { name: "已复制" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 HTML" }).click();
  const downloadedReport = await download;
  expect(downloadedReport.suggestedFilename()).toBe("session-report.html");
  const downloadedPath = await downloadedReport.path();
  expect(downloadedPath).toBeTruthy();
  const downloadedHtml = readFileSync(downloadedPath!, "utf8");
  expect(downloadedHtml).toContain('<section class="session">');
  expect(downloadedHtml).toContain("Trace 概览");
  expect(downloadedHtml).toContain("Token 变化");
  expect(downloadedHtml).toContain("上下文压力");
  expect(downloadedHtml).toContain("<svg");
  expect(downloadedHtml).toContain("2 / 1");
  expect(downloadedHtml).toMatch(/bash · 1 calls · 1 failed/i);
  expect(downloadedHtml).toMatch(/<base href="http:\/\/127\.0\.0\.1:\d+\/">/);
  expect(downloadedHtml).toMatch(/href="\/sessions\/[^"]+(?:\?focus=[^"]+)?"/);
  await expect(page.getByRole("button", { name: "打印" })).toBeVisible();

  await page.goto("/");
  await page.locator(".top-import summary").click();
  const many = generatedSessions();
  for (const batch of [many.slice(0, 20), many.slice(20, 40), many.slice(40)]) {
    const imported = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/session-insights/import") &&
        response.request().method() === "POST",
    );
    await page
      .locator(".top-import")
      .getByTestId("file-input")
      .setInputFiles(batch);
    await imported;
    await expect(page.getByTestId("import-result")).toContainText(
      `新增 ${batch.length}`,
    );
  }
  const importedCrossDay = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/session-insights/import") &&
      response.request().method() === "POST",
  );
  await page
    .locator(".top-import")
    .getByTestId("file-input")
    .setInputFiles(crossDaySession());
  await importedCrossDay;
  await expect(page.getByTestId("import-result")).toContainText("新增 1");
  await expect(page.getByTestId("load-more")).toBeVisible();
  expect(await page.locator(".session-table tbody tr").count()).toBe(50);
  await page.getByTestId("load-more").click();
  await expect
    .poll(() => page.locator(".session-table tbody tr").count())
    .toBeGreaterThan(50);

  await page.goto("/compare");
  await expect(page.getByTestId("compare-load-more")).toBeVisible();
  const pickerOptionsBefore = await page
    .locator(".compare-pickers option")
    .count();
  await page.getByTestId("compare-load-more").click();
  await expect
    .poll(() => page.locator(".compare-pickers option").count())
    .toBeGreaterThan(pickerOptionsBefore);

  // Picker options are headlined by the derived title, and the 51 generated
  // fixtures all share one prompt, so the run has to be resolved by id.
  const crossDayListing = (await page.evaluate(() =>
    fetch("/api/session-insights/runs?limit=100&q=e2e-cross-day").then(
      (response) => response.json(),
    ),
  )) as { runs: Array<{ id: string; sourceSessionId?: string }> };
  const crossDayRun = crossDayListing.runs.find(
    (run) => run.sourceSessionId === "e2e-cross-day",
  );
  expect(crossDayRun).toBeDefined();
  await page.getByLabel("基线 session").selectOption(codexRun);
  await page.getByLabel("候选 session").selectOption(crossDayRun!.id);
  await expect(page.locator(".compare-lane")).toHaveCount(2);
  await page.getByRole("button", { name: "标准化时间" }).click();
  await expect(page.locator(".compare-axis").first()).toContainText(
    /\d{2}\/\d{2}/,
  );

  await page.goto("/report");
  await expect(page.getByTestId("report-load-more")).toBeVisible();
  const reportOptionsBefore = await page
    .getByLabel("报告 session")
    .locator("option")
    .count();
  await page.getByTestId("report-load-more").click();
  await expect
    .poll(() => page.getByLabel("报告 session").locator("option").count())
    .toBeGreaterThan(reportOptionsBefore);

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(codexTraceUrl);
  await page
    .locator(".session-tabs")
    .getByRole("button", { name: /时间轴/ })
    .click();
  await expect(page.getByTestId("trace-inspector")).toBeVisible();
  await expect(
    page.getByRole("slider", { name: /执行证据时间轴/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await expect(page.locator(".session-table thead")).toBeHidden();
  const mobileRow = page.locator(".session-table tbody tr").first();
  await expect(mobileRow).toBeVisible();
  const mobileRun = (
    await mobileRow.locator(".session-link").getAttribute("data-testid")
  )?.replace("session-", "");
  expect(mobileRun).toBeTruthy();
  await page.goto(`/sessions/${mobileRun}`);
  await page.getByRole("button", { name: /时间轴/ }).click();
  await page.getByRole("tab", { name: "结构" }).click();
  await expect(page.locator(".trace-studio")).toHaveAttribute(
    "data-mobile-panel",
    "tree",
  );
  await page.getByRole("tab", { name: "时间轴" }).click();
  await expect(page.locator(".trace-studio")).toHaveAttribute(
    "data-mobile-panel",
    "timeline",
  );
  await page.getByRole("tab", { name: "检查器" }).click();
  await expect(page.locator(".trace-studio")).toHaveAttribute(
    "data-mobile-panel",
    "inspector",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel("切换到深色模式").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  expect(apiFailures).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
