import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
