import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  App,
  formatCompareTick,
  reportHtml,
  timeMapper,
} from "./app";
import { duration, number, relativeTime, tokens, timelineDuration, trackedTokenTotal } from "./format";
import { isTelemetryOnly, runLabel, spanHint } from "./session-model";

const run = {
  id: "run-1",
  sessionRef: "codex-8ac3",
  provider: "codex",
  runKind: "interactive",
  startedAt: "2026-08-30T08:00:00Z",
  durationMs: 120000,
  endedAt: "2026-08-30T08:02:00Z",
  tokens: { inputUncached: 12, output: 8, total: 20 },
  counts: {
    userTurns: 1,
    followUps: 0,
    corrections: 1,
    tools: 3,
    toolFailures: 0,
    verifications: 0,
    subagents: 0,
    compactions: 0,
  },
  phaseSequence: [
    {
      phase: "plan",
      startOffsetMs: 0,
      durationMs: 1000,
      eventCount: 1,
      toolCalls: 0,
      toolFailures: 0,
    },
    {
      phase: "execute",
      startOffsetMs: 1000,
      durationMs: 1000,
      eventCount: 2,
      toolCalls: 3,
      toolFailures: 0,
    },
  ],
  phaseCounts: { plan: 1, execute: 2 },
  toolCounts: { exec: { calls: 3, failures: 0 } },
  skillActivity: { inferred: { query: 1 } },
  correctionSignals: [{ type: "change_course", count: 1, quality: "inferred" }],
  verification: {
    status: "unknown",
    summary: "未识别到可验证证据",
    evidenceCount: 0,
  },
  quality: {
    token: "exact",
    correction: "inferred",
    tools: "exact",
    verification: "unknown",
  },
  origin: "import",
  importedAt: "2026-08-30T08:03:00Z",
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const body = /\/runs\/run-[12]$/.test(url)
        ? {
            ...run,
            id: url.endsWith("run-2") ? "run-2" : "run-1",
            sessionRef: url.endsWith("run-2") ? "claude-2" : run.sessionRef,
          }
        : {
            runs: [run, { ...run, id: "run-2", sessionRef: "claude-2" }],
            total: 2,
          };
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    }),
  );
});

afterEach(() => cleanup());

describe("Session Insight", () => {
  it("does not double count reasoning output in a tracked-token fallback", () => {
    expect(
      trackedTokenTotal({
        inputUncached: 723115,
        cacheRead: 11444224,
        cacheWrite: 0,
        output: 77128,
        reasoning: 36392,
      }),
    ).toBe(12244467);
  });

  it("preserves observed zero values while keeping missing values unavailable", () => {
    expect(number(0)).toBe("0");
    expect(tokens(0)).toBe("0 tokens");
    expect(duration(0)).toBe("0s");
    expect(number(undefined)).toBe("—");
    expect(tokens(undefined)).toBe("—");
    expect(duration(undefined)).toBe("—");
  });

  it("includes the date in cross-day real-time ticks", () => {
    expect(
      formatCompareTick(new Date("2026-08-31T00:30:00+08:00").getTime(), true),
    ).toMatch(/08.*31/);
    expect(
      formatCompareTick(new Date("2026-08-31T00:30:00+08:00").getTime(), false),
    ).not.toMatch(/08.*31/);
  });

  it("lists sessions and navigates to a directly refreshable detail route", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText("codex-8ac3")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("session-run-1"));
    expect(await screen.findByTestId("session-detail")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /信号需要检查/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /时间轴/ }));
    expect(screen.getByText("事件结构")).toBeInTheDocument();
    expect(screen.getByText("工具调用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("treeitem", { name: /plan/ }));
    expect(screen.getByTestId("trace-inspector")).toHaveTextContent("摘要");
  });

  it("uses coherent landmark navigation and real links for session rows", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "跳到主要内容" })).toHaveAttribute(
      "href",
      "#main-content",
    );
    expect(screen.getByRole("link", { name: "会话库" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.queryByRole("link", { name: "Trace" }),
    ).not.toBeInTheDocument();

    const sessionLink = await screen.findByRole("link", { name: /codex-8ac3/ });
    expect(sessionLink).toHaveAttribute("href", "/sessions/run-1");
  });

  it("labels trace viewport controls and exposes their pressed state", async () => {
    render(
      <MemoryRouter initialEntries={["/sessions/run-1"]}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByTestId("session-detail");
    fireEvent.click(screen.getByRole("button", { name: /时间轴/ }));
    expect(
      screen.getByRole("button", { name: "放大时间轴" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "缩小时间轴" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("compressed-time")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "仅失败" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("submits selected session files as multipart import", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    const file = new File(["{}"], "session.json", { type: "application/json" });
    fireEvent.change(screen.getByTestId("file-input"), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(screen.getByTestId("import-result")).toHaveTextContent("新增"),
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/session-insights/import",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends boolean backend filters instead of display-only values", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText("codex-8ac3");
    fireEvent.change(screen.getByLabelText("异常"), {
      target: { value: "true" },
    });
    fireEvent.change(screen.getByLabelText("上下文风险"), {
      target: { value: "true" },
    });
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([url]) =>
              String(url).includes("error=true") &&
              String(url).includes("contextRisk=true"),
          ),
      ).toBe(true),
    );
  });

  it("offers the normalized TraeX provider filter", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText("codex-8ac3");
    expect(screen.getByRole("option", { name: "TraeX" })).toHaveValue("traex");
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "traex" },
    });
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([url]) => String(url).includes("provider=traex")),
      ).toBe(true),
    );
  });

  it("clears only the local analysis index after confirmation", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTestId("clear-runs"));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/session-insights/runs",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("compares two API-backed traces and filters both sides from a difference row", async () => {
    render(
      <MemoryRouter initialEntries={["/compare?a=run-1&b=run-2"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: /codex-8ac3.*claude-2/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "标准化时间" }));
    expect(
      screen.getByRole("button", { name: "共同真实时间" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("exec"));
    expect(screen.getByText(/已同步筛选：exec/)).toBeInTheDocument();
  });

  it("does not turn an unavailable comparison side into an observed zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input),
          second = url.endsWith("run-2");
        const body = /\/runs\/run-[12]$/.test(url)
          ? {
              ...run,
              id: second ? "run-2" : "run-1",
              sessionRef: second ? "claude-2" : run.sessionRef,
              toolCounts: second ? {} : { exec: { calls: 3 } },
              quality: { ...run.quality, tools: second ? "unknown" : "exact" },
            }
          : {
              runs: [run, { ...run, id: "run-2", sessionRef: "claude-2" }],
              total: 2,
            };
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200 }),
        );
      }),
    );
    render(
      <MemoryRouter initialEntries={["/compare?a=run-1&b=run-2"]}>
        <App />
      </MemoryRouter>,
    );
    const row = (await screen.findByText("exec")).closest("tr");
    expect(row).toHaveTextContent("— · 未观测");
    expect(row?.lastElementChild).toHaveTextContent("—");
  });

  it("keeps a per-tool observed zero even when aggregate outcome quality is partial", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input),
          second = url.endsWith("run-2");
        const body = /\/runs\/run-[12]$/.test(url)
          ? {
              ...run,
              id: second ? "run-2" : "run-1",
              sessionRef: second ? "claude-2" : run.sessionRef,
              toolCounts: { exec: { calls: second ? 0 : 3 } },
              quality: { ...run.quality, tools: second ? "unknown" : "exact" },
            }
          : {
              runs: [run, { ...run, id: "run-2", sessionRef: "claude-2" }],
              total: 2,
            };
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200 }),
        );
      }),
    );
    render(
      <MemoryRouter initialEntries={["/compare?a=run-1&b=run-2"]}>
        <App />
      </MemoryRouter>,
    );
    const row = (await screen.findByText("exec")).closest("tr");
    expect(row).toHaveTextContent("Toolexec30-3");
    expect(row).not.toHaveTextContent("未观测");
  });

  it("renders a fact report from an API response without adding reasoning to tracked tokens", async () => {
    render(
      <MemoryRouter initialEntries={["/report?run=run-1"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText("Session 分析报告"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Reasoning tokens are an output subset", {
        exact: false,
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("20 tokens / —")).toBeInTheDocument();
  });

  it("builds a standalone HTML report with sections, inline charts, and Trace evidence links", () => {
    const html = reportHtml(
      [
        {
          ...run,
          trace: [
            {
              id: "tool-1",
              type: "tool",
              name: "exec",
              startOffsetMs: 1000,
              durationMs: 500,
              tokenDelta: { inputUncached: 5, output: 2 },
              contextRatio: 0.5,
            },
          ],
        },
      ],
      "http://127.0.0.1:4788",
    );
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Trace 概览");
    expect(html).toContain("Token 变化");
    expect(html).toContain("上下文压力");
    expect(html).toContain("证据线索");
    expect(html).toContain("<svg");
    expect(html).toContain('<base href="http://127.0.0.1:4788/">');
    expect(html).toContain('href="/sessions/run-1?focus=tool-1"');
    expect(html).not.toContain("white-space:pre-wrap");
  });

  it("masks backend default zeroes when tool evidence quality is unavailable", () => {
    const html = reportHtml([
      {
        ...run,
        counts: { ...run.counts, tools: 0, toolFailures: 0 },
        toolCounts: { exec: { calls: 0, failures: 0 } },
        quality: { ...run.quality, tools: "unknown" },
      },
    ]);
    expect(html).toContain("工具 / 失败</small><b>— / —</b>");
    expect(html).not.toContain("工具 / 失败</small><b>0 / 0</b>");
  });

  it("retains Claude calls and explicit failures despite partial aggregate outcome quality", () => {
    const html = reportHtml([
      {
        ...run,
        provider: "claude",
        counts: { ...run.counts, tools: 2, toolFailures: 1 },
        toolCounts: { Bash: { calls: 1, failures: 1 } },
        skillActivity: { inferred: { query: 1 } },
        quality: { ...run.quality, tools: "unknown" },
        trace: [
          {
            id: "bash-error",
            type: "tool",
            name: "Bash",
            tool: "Bash",
            status: "error",
            error: "exit 1",
            startOffsetMs: 1000,
            durationMs: 10,
          },
          {
            id: "skill",
            type: "skill",
            name: "query",
            skill: "query",
            status: "unknown",
            startOffsetMs: 2000,
            durationMs: 10,
          },
        ],
      },
    ]);
    expect(html).toContain("工具 / 失败</small><b>2 / 1</b>");
    expect(html).toContain("Bash · 1 calls · 1 failed");
    expect(html).toContain("query · 1 · inferred");
    expect(html).toContain("1 个结构化失败");
  });

  it("keeps real Agent responses in Conversation while excluding model telemetry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ...run,
              trace: [
                {
                  id: "u",
                  type: "user",
                  name: "User",
                  start: "2026-08-30T08:00:00Z",
                  end: "2026-08-30T08:00:01Z",
                  input: "request",
                },
                {
                  id: "m",
                  type: "model",
                  name: "Agent response",
                  start: "2026-08-30T08:00:02Z",
                  end: "2026-08-30T08:00:03Z",
                  output: "answer",
                },
                {
                  id: "p",
                  type: "model",
                  name: "Token pulse",
                  start: "2026-08-30T08:00:04Z",
                  end: "2026-08-30T08:00:05Z",
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/sessions/run-1"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByTestId("session-detail");
    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(screen.getByText(/request/)).toBeInTheDocument();
    expect(screen.getByText(/answer/)).toBeInTheDocument();
    expect(screen.queryByText("内容摘要不可用")).not.toBeInTheDocument();
    expect(screen.queryByText("Token pulse")).not.toBeInTheDocument();
  });

  it("actually remaps events when derived idle spans are compressed", () => {
    const spans = [
      {
        id: "start",
        type: "user",
        name: "User",
        startOffsetMs: 0,
        durationMs: 1_000,
      },
      {
        id: "idle",
        type: "idle",
        name: "No observed activity",
        startOffsetMs: 1_000,
        durationMs: 599_000,
      },
      {
        id: "end",
        type: "tool",
        name: "exec",
        startOffsetMs: 600_000,
        durationMs: 1_000,
      },
      {
        id: "tail",
        type: "model",
        name: "Agent response",
        startOffsetMs: 659_000,
        durationMs: 1_000,
      },
    ];
    const compressed = timeMapper([0, 660_000], spans, true);
    const real = timeMapper([0, 660_000], spans, false);
    expect(compressed.compressedGaps).toBeGreaterThan(0);
    expect(compressed.at(600_000)).not.toBe(real.at(600_000));
  });

  it("keeps a thousand-span trace bounded and keyboard navigable", async () => {
    const trace = Array.from({ length: 1000 }, (_, index) => ({
      id: `span-${index}`,
      type: index % 4 === 0 ? "tool" : "model",
      name: `event-${index}`,
      startOffsetMs: index * 100,
      durationMs: 50,
      status: index % 197 === 0 ? "error" : "ok",
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ...run, durationMs: 100_000, trace }), {
            status: 200,
          }),
        ),
      ),
    );
    render(
      <MemoryRouter
        initialEntries={["/sessions/run-1?view=timeline&density=full"]}
      >
        <App />
      </MemoryRouter>,
    );
    await screen.findByTestId("session-detail");
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(80);
    expect(
      screen.getByRole("slider", { name: /执行证据时间轴/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("显示 1000 / 1000 个事件")).toBeInTheDocument();
  });

  it("loads a second page so sessions beyond the first 50 remain discoverable", async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({
      ...run,
      id: `run-${index}`,
      sessionRef: `session-${index}`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const second = String(input).includes("cursor=next");
        return Promise.resolve(
          new Response(
            JSON.stringify(
              second
                ? {
                    runs: [{ ...run, id: "run-51", sessionRef: "session-51" }],
                    total: 51,
                  }
                : { runs: first, total: 51, nextCursor: "next" },
            ),
            { status: 200 },
          ),
        );
      }),
    );
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText("session-49");
    fireEvent.click(screen.getByTestId("load-more"));
    expect(await screen.findByText("session-51")).toBeInTheDocument();
  });

  it("loads the next cursor into the Report session picker", async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({
      ...run,
      id: `run-${index}`,
      sessionRef: `session-${index}`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/runs/run-0"))
          return Promise.resolve(
            new Response(JSON.stringify(first[0]), { status: 200 }),
          );
        const second = url.includes("cursor=next");
        return Promise.resolve(
          new Response(
            JSON.stringify(
              second
                ? {
                    runs: [{ ...run, id: "run-51", sessionRef: "session-51" }],
                    total: 51,
                  }
                : { runs: first, total: 51, nextCursor: "next" },
            ),
            { status: 200 },
          ),
        );
      }),
    );
    render(
      <MemoryRouter initialEntries={["/report?run=run-0"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText("Session 分析报告");
    fireEvent.click(await screen.findByTestId("report-load-more"));
    expect(
      await screen.findByRole("option", { name: /session-51/ }),
    ).toBeInTheDocument();
  });
});

describe("发现与降噪", () => {
  it("uses the derived title as the row headline and falls back without repeating the id", () => {
    expect(runLabel({ id: "r", title: "深度审查知识库", project: "kb" })).toBe(
      "深度审查知识库",
    );
    // No title: project plus a short id, so the row is still identifiable.
    expect(
      runLabel({ id: "r", sourceSessionId: "01a052ab-7004-7371", project: "kb" }),
    ).toBe("kb · 01a052ab");
    // Neither title nor project: the raw id is all we have.
    expect(runLabel({ id: "r", sourceSessionId: "01a052ab-7004" })).toBe(
      "01a052ab-7004",
    );
  });

  it("treats token pulses and empty reasoning as telemetry, not as events", () => {
    expect(isTelemetryOnly({ type: "model", name: "Token pulse" })).toBe(true);
    expect(isTelemetryOnly({ type: "model", name: "Reasoning" })).toBe(true);
    // Reasoning that actually recorded text is real content.
    expect(
      isTelemetryOnly({ type: "model", name: "Reasoning", output: "计划如下" }),
    ).toBe(false);
    expect(
      isTelemetryOnly({ type: "tool", name: "command_execution" }),
    ).toBe(false);
    expect(isTelemetryOnly({ type: "user", name: "User message" })).toBe(false);
  });

  it("reads header metrics from /stats so they describe every match, not the loaded page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/stats")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                runCount: 655,
                tokens: { total: 4492506421, cacheRead: 4000000000 },
                tokenRunCount: 603,
                toolCalls: 29000,
                toolFailures: 680,
                failedRunCount: 202,
                contextRiskRuns: 30,
                correctionRuns: 237,
                subagentRuns: 67,
                wallDurationMs: 6420000,
                activeDurationMs: 1460000,
                idleDurationMs: 4960000,
                cacheHitRatio: 0.98,
                providers: [],
                models: [],
                projects: [],
                tools: [],
                daily: [],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ runs: [run], total: 655, nextCursor: "next" }),
            { status: 200 },
          ),
        );
      }),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    // One run is loaded but the header must speak for all 655.
    expect(await screen.findByText(/覆盖全部 655 个匹配 session/)).toBeInTheDocument();
    expect(await screen.findByText(/分布在 202 个 session/)).toBeInTheDocument();
    expect(await screen.findByText("存在工具失败 (202)")).toBeInTheDocument();
    expect(await screen.findByText("98%")).toBeInTheDocument();
  });

  it("shows why a run matched when the hit is in the conversation body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/stats"))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                runCount: 1,
                tokens: {},
                tokenRunCount: 0,
                toolCalls: 0,
                toolFailures: 0,
                failedRunCount: 0,
                contextRiskRuns: 0,
                correctionRuns: 0,
                subagentRuns: 0,
                wallDurationMs: 0,
                activeDurationMs: 0,
                idleDurationMs: 0,
                providers: [],
                models: [],
                projects: [],
                tools: [],
                daily: [],
              }),
              { status: 200 },
            ),
          );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              runs: [
                {
                  ...run,
                  title: "本机怎么运行 ccflash",
                  snippet: "…我会先查个人知识库里的既有经验，然后并行看本机与远端…",
                },
              ],
              total: 1,
            }),
            { status: 200 },
          ),
        );
      }),
    );
    render(
      <MemoryRouter initialEntries={["/?q=知识库"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText("本机怎么运行 ccflash")).toBeInTheDocument();
    expect(
      await screen.findByText(/我会先查个人知识库里的既有经验/),
    ).toBeInTheDocument();
  });

  it("formats recent timestamps relatively", () => {
    const now = Date.parse("2026-08-31T12:00:00Z");
    expect(relativeTime("2026-08-31T11:58:00Z", now)).toBe("2 分钟前");
    expect(relativeTime("2026-08-31T09:00:00Z", now)).toBe("3 小时前");
    expect(relativeTime("2026-08-29T12:00:00Z", now)).toBe("2 天前");
    expect(relativeTime(undefined, now)).toBe("未知时间");
  });

  it("does not round sub-second events down to 0s", () => {
    expect(timelineDuration(0)).toBe("0s");
    expect(timelineDuration(37)).toBe("37ms");
    expect(timelineDuration(940)).toBe("940ms");
    expect(timelineDuration(3300)).toBe("3.3s");
    expect(timelineDuration(42000)).toBe("42s");
    expect(timelineDuration(600000)).toBe("10m");
  });

  it("derives a distinguishing hint for rows that share a tool name", () => {
    expect(spanHint({ tool: "bash", input: '{"command":"npm test"}' })).toBe(
      "npm test",
    );
    // Excerpts are byte-capped, so many tool inputs never parse as JSON.
    expect(
      spanHint({ tool: "edit", input: '{"replace_all":false,"file_path":"/a/b.ts","old' }),
    ).toBe("/a/b.ts");
    expect(
      spanHint({
        type: "user",
        input: '<teammate-message teammate_id="lead" summary="修 runner 契约">正文</teammate-message>',
      }),
    ).toBe("修 runner 契约");
    expect(spanHint({ type: "model" })).toBe("");
  });
});
