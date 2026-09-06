import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionOverview, SessionTokens } from "./session-analysis";
import type { SessionRun, TraceSpan } from "./types";

afterEach(cleanup);

const failure: TraceSpan = {
  id: "failed-exec",
  type: "tool",
  tool: "exec_command",
  status: "error",
  error: "permission denied",
  durationMs: 2400,
};

const run: SessionRun = {
  id: "run-1",
  tokens: { inputUncached: 100, cacheRead: 50, cacheWrite: 10, output: 40 },
  counts: { tools: 2, toolFailures: 1, corrections: 1 },
  toolCounts: { exec_command: { calls: 2, failures: 1 } },
  quality: { token: "exact", tools: "observed", correction: "heuristic" },
};

describe("SessionOverview", () => {
  it("opens a concrete failed event and its tool chain", () => {
    const openSpan = vi.fn();
    const openTool = vi.fn();
    render(<SessionOverview run={run} spans={[failure]} openSpan={openSpan} openTool={openTool} openTokens={vi.fn()} />);

    expect(screen.getByText("permission denied")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "定位 Trace" })[0]);
    expect(openSpan).toHaveBeenCalledWith(failure);
    fireEvent.click(screen.getByRole("button", { name: "查看链路" }));
    expect(openTool).toHaveBeenCalledWith("exec_command");
  });

  it("does not describe missing observations as stable", () => {
    render(<SessionOverview run={{ id: "empty" }} spans={[]} openSpan={vi.fn()} openTool={vi.fn()} openTokens={vi.fn()} />);
    expect(screen.getByText(/缺失字段不视作运行稳定/)).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("marks unknown tool results as unavailable instead of a successful zero", () => {
    const unknownTools = Array.from({ length: 45 }, (_, index) => ({
      id: `tool-${index}`,
      type: "tool",
      tool: "exec_command",
      status: "unknown",
    }));
    render(<SessionOverview run={{
      id: "legacy",
      counts: { tools: 45, toolFailures: 0 },
      toolCounts: { exec_command: { calls: 45, failures: 0 } },
      quality: { tools: "unknown" },
    }} spans={unknownTools} openSpan={vi.fn()} openTool={vi.fn()} openTokens={vi.fn()} />);

    expect(screen.getByText(/45 次结果未判定/)).toBeInTheDocument();
    expect(screen.getByText(/不能据此判断成功或失败/)).toBeInTheDocument();
    expect(screen.getByText(/工具调用时长不可用/)).toBeInTheDocument();
    expect(screen.queryByText("0")).toBeNull();
  });
});

describe("SessionTokens", () => {
  function metric(label: string) {
    return within(screen.getByText(label, { selector: "dt" }).closest("div")!);
  }

  it("shows session output rates, cache reuse and output composition with explicit denominators", () => {
    render(<SessionTokens run={{
      id: "efficiency", durationMs: 20000, activeDurationMs: 10000,
      counts: { userTurns: 4 },
      tokens: { inputUncached: 100, cacheRead: 300, cacheWrite: 100, output: 200, reasoning: 50 },
      quality: { token: "derived", inputTokens: "derived", outputTokens: "exact", reasoningTokens: "derived" },
    }} spans={[]} openSpan={vi.fn()} />);

    expect(metric("活跃期输出速率").getByText("20 tokens/s")).toBeInTheDocument();
    expect(metric("活跃期输出速率").getByText("启发式")).toBeInTheDocument();
    expect(metric("全程输出速率").getByText("10 tokens/s")).toBeInTheDocument();
    expect(metric("缓存读取率").getByText("75%")).toBeInTheDocument();
    expect(metric("缓存读取率").getByText(/不含 Cache write/)).toBeInTheDocument();
    expect(metric("每轮平均输出").getByText("50 tokens/轮")).toBeInTheDocument();
    expect(metric("推理占输出").getByText("25%")).toBeInTheDocument();
    expect(metric("输出占已追踪 Token").getByText("28.57%")).toBeInTheDocument();
    expect(screen.getByText(/不能读作模型解码速度/)).toBeInTheDocument();
  });

  it("preserves observed zero rates while leaving undefined ratios unavailable", () => {
    render(<SessionTokens run={{
      id: "zero-rates", durationMs: 20000, activeDurationMs: 10000,
      counts: { userTurns: 2 }, tokens: { inputUncached: 100, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    }} spans={[]} openSpan={vi.fn()} />);
    expect(metric("活跃期输出速率").getByText("0 tokens/s")).toBeInTheDocument();
    expect(metric("全程输出速率").getByText("0 tokens/s")).toBeInTheDocument();
    expect(metric("缓存读取率").getByText("0%")).toBeInTheDocument();
    expect(metric("每轮平均输出").getByText("0 tokens/轮")).toBeInTheDocument();
    expect(metric("推理占输出").getByText("—")).toBeInTheDocument();
    expect(metric("输出占已追踪 Token").getByText("0%")).toBeInTheDocument();
  });

  it("does not infer output, cache or timing from incomplete fields and pulse intervals", () => {
    const rendered = render(<SessionTokens run={{
      id: "partial", tokens: { cacheRead: 100, reasoning: 10 },
    }} spans={[{ id: "pulse", type: "model", durationMs: 1000, tokenDelta: { output: 20 } }]} openSpan={vi.fn()} />);
    expect(metric("活跃期输出速率").getByText("—")).toBeInTheDocument();
    expect(metric("全程输出速率").getByText("—")).toBeInTheDocument();
    expect(metric("缓存读取率").getByText("—")).toBeInTheDocument();
    expect(metric("推理占输出").getByText("—")).toBeInTheDocument();
    expect(metric("输出占已追踪 Token").getByText("—")).toBeInTheDocument();
    rendered.rerender(<SessionTokens run={{ id: "untimed", tokens: { output: 20 } }} spans={[]} openSpan={vi.fn()} />);
    expect(metric("活跃期输出速率").getByText("—")).toBeInTheDocument();
    expect(metric("全程输出速率").getByText("—")).toBeInTheDocument();
    expect(metric("每轮平均输出").getByText("—")).toBeInTheDocument();
    expect(metric("输出占已追踪 Token").getByText("—")).toBeInTheDocument();
  });

  it("rejects zero duration and inconsistent subset values without producing infinities", () => {
    render(<SessionTokens run={{
      id: "invalid", durationMs: 0, activeDurationMs: 1000, counts: { userTurns: 0 },
      tokens: { output: 20, reasoning: 30, inputUncached: 0, cacheRead: 0, total: 10 },
    }} spans={[]} openSpan={vi.fn()} />);
    for (const label of ["活跃期输出速率", "全程输出速率", "缓存读取率", "每轮平均输出", "推理占输出", "输出占已追踪 Token"])
      expect(metric(label).getByText("—")).toBeInTheDocument();
  });

  it("keeps estimated output quality and does not round tiny nonzero rates to zero", () => {
    render(<SessionTokens run={{
      id: "estimated", wallDurationMs: 200000, durationMs: 1000, activeDurationMs: 100000,
      tokens: { inputUncached: 0, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 1 }, counts: { userTurns: 1 },
      quality: { token: "derived", inputTokens: "derived", outputTokens: "estimated", reasoningTokens: "derived" },
    }} spans={[]} openSpan={vi.fn()} />);
    expect(metric("全程输出速率").getByText("<0.01 tokens/s")).toBeInTheDocument();
    for (const label of ["活跃期输出速率", "全程输出速率", "每轮平均输出", "推理占输出", "输出占已追踪 Token"])
      expect(metric(label).getByText("估算")).toBeInTheDocument();
  });

  it("does not round near-full cache reuse to full reuse and warns about incomplete timestamps", () => {
    render(<SessionTokens run={{
      id: "coverage", tokens: { inputUncached: 1, cacheRead: 1000000 },
      parseWarnings: ["unknown_timestamp"],
    }} spans={[]} openSpan={vi.fn()} />);
    expect(metric("缓存读取率").getByText(">99.99%")).toBeInTheDocument();
    expect(screen.getByText(/部分事件缺少时间戳/)).toBeInTheDocument();
  });

  it("keeps the weaker quality of every token bucket participating in a ratio", () => {
    const rendered = render(<SessionTokens run={{
      id: "weak-input", tokens: { inputUncached: 10, cacheRead: 0, cacheWrite: 0, output: 20, reasoning: 10 },
      quality: { inputTokens: "unknown", outputTokens: "exact", reasoningTokens: "unknown" },
    }} spans={[]} openSpan={vi.fn()} />);
    expect(metric("推理占输出").getByText("50%")).toBeInTheDocument();
    expect(metric("推理占输出").getByText("不可用")).toBeInTheDocument();
    expect(metric("输出占已追踪 Token").getByText("不可用")).toBeInTheDocument();
    rendered.rerender(<SessionTokens run={{
      id: "estimated-reasoning", tokens: { output: 20, reasoning: 10 },
      quality: { outputTokens: "exact", reasoningTokens: "estimated" },
    }} spans={[]} openSpan={vi.fn()} />);
    expect(metric("推理占输出").getByText("估算")).toBeInTheDocument();
  });

  it("labels empty or missing source quality instead of rendering a blank badge", () => {
    render(<SessionTokens run={{
      id: "missing-quality", durationMs: 1000, activeDurationMs: 1000,
      tokens: { output: 20, inputUncached: 10, cacheRead: 10 }, quality: { outputTokens: "" },
    }} spans={[]} openSpan={vi.fn()} />);
    for (const label of ["活跃期输出速率", "全程输出速率", "缓存读取率"])
      expect(metric(label).getByText("不可用")).toBeInTheDocument();
  });

  it("keeps zero separate from missing token buckets and opens a sampled pulse", () => {
    const openSpan = vi.fn();
    const pulse: TraceSpan = {
      id: "pulse",
      name: "Token pulse",
      tokenDelta: { inputUncached: 0, output: 9 },
      parentId: "parent",
    };
    const parent: TraceSpan = { id: "parent", name: "模型输出" };
    render(<SessionTokens run={{ id: "zero", tokens: { inputUncached: 0, output: 0 }, quality: { token: "exact" } }} spans={[pulse, parent]} openSpan={openSpan} />);

    expect(screen.getAllByText("0 tokens").length).toBeGreaterThan(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText("父事件：模型输出")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "定位 Trace" }));
    expect(openSpan).toHaveBeenCalledWith(pulse);
  });
  it("groups pulse consumption by recorded user parents without guessing unlinked ownership", () => {
    const openSpan = vi.fn();
    const parent: TraceSpan = { id: "user-1", type: "user", input: "分析耗时" };
    render(<SessionTokens run={{ id: "turns" }} spans={[
      parent,
      { id: "pulse-1", parentId: parent.id, tokenDelta: { inputUncached: 10, output: 5, reasoning: 3 } },
      { id: "pulse-2", parentId: parent.id, tokenDelta: { cacheRead: 20 } },
      { id: "unlinked", tokenDelta: { output: 90 } },
    ]} openSpan={openSpan} />);
    expect(screen.getByText("35 tokens")).toBeInTheDocument();
    expect(screen.getByText(/2 个已记录脉冲/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "定位轮次" }));
    expect(openSpan).toHaveBeenCalledWith(parent);
  });

});
