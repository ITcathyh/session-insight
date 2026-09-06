import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Insights } from "./insights";
import type { Stats } from "./types";

const baseStats: Omit<Stats, "tokens" | "tokenRunCount" | "projects" | "daily"> = {
  runCount: 1,
  toolCalls: 0,
  toolFailures: 0,
  toolRunCount: 0,
  toolOutcomeRunCount: 0,
  failedRunCount: 0,
  contextRiskRuns: 0,
  correctionRuns: 0,
  subagentRuns: 0,
  wallDurationMs: 0,
  activeDurationMs: 0,
  idleDurationMs: 0,
  providers: [],
  models: [],
  tools: [],
};

function renderStats(stats: Stats) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(stats), { status: 200 }))),
  );
  render(
    <MemoryRouter>
      <Insights />
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe("Insights token coverage", () => {
  it("renders unavailable token aggregates as an em dash", async () => {
    renderStats({
      ...baseStats,
      tokens: {},
      tokenRunCount: 0,
      projects: [{ name: "missing", runs: 1, tokenRunCount: 0, durationMs: 0, failures: 0 }],
      daily: [{ date: "2026-08-30", runs: 1, tokenRunCount: 0, failures: 0 }],
    });

    await screen.findByRole("heading", { name: "全局分析" });
    expect(screen.getByText("累计 Tokens").parentElement?.parentElement).toHaveTextContent("—");
    expect(screen.getByRole("link", { name: "missing" }).closest("tr")).toHaveTextContent("—（0/1 个已观测）");
    expect(screen.getByTitle(/— tokens · 0\/1 个 session 有 token 观测/)).toBeInTheDocument();
  });

  it("keeps an observed zero and shows partial project coverage", async () => {
    renderStats({
      ...baseStats,
      runCount: 2,
      tokens: { inputUncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
      tokenRunCount: 1,
      projects: [{ name: "mixed", runs: 2, tokens: 0, tokenRunCount: 1, durationMs: 0, failures: 0 }],
      daily: [{ date: "2026-08-30", runs: 2, tokens: 0, tokenRunCount: 1, failures: 0 }],
    });

    expect(await screen.findByText("0 tokens")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "mixed" }).closest("tr")).toHaveTextContent("0（1/2 个已观测）");
    expect(screen.getByTitle(/0 tokens · 1\/2 个 session 有 token 观测/)).toBeInTheDocument();
    expect(screen.getByText("峰值 0 tokens")).toBeInTheDocument();
  });

  it("keeps unknown tool outcomes unavailable while preserving recorded failures", async () => {
    renderStats({
      ...baseStats,
      toolCalls: 48,
      toolFailures: 2,
      toolRunCount: 2,
      projects: [],
      daily: [],
      tokens: {},
      tokenRunCount: 0,
    });

    await screen.findByRole("heading", { name: "全局分析" });
    const failures = screen.getByText("工具失败").parentElement?.parentElement;
    expect(failures).toHaveTextContent("2");
    expect(failures).toHaveTextContent("已记录 2 次失败；0/1 个 session 的工具结果可判定。");
  });

  it("does not display an unobserved zero tool failure count", async () => {
    renderStats({
      ...baseStats,
      toolCalls: 45,
      toolRunCount: 1,
      projects: [],
      daily: [],
      tokens: {},
      tokenRunCount: 0,
    });

    await screen.findByRole("heading", { name: "全局分析" });
    const failures = screen.getByText("工具失败").parentElement?.parentElement;
    expect(failures).toHaveTextContent("—");
    expect(failures).toHaveTextContent("1 个 session 记录了工具调用；没有可判定的工具结果。");
  });

  it("does not display a failure count when no tool evidence is available", async () => {
    renderStats({
      ...baseStats,
      projects: [],
      daily: [],
      tokens: {},
      tokenRunCount: 0,
    });

    await screen.findByRole("heading", { name: "全局分析" });
    const failures = screen.getByText("工具失败").parentElement?.parentElement;
    expect(failures).toHaveTextContent("—");
    expect(failures).toHaveTextContent("没有可判定的工具结果。");
    const affected = screen.getByText("受影响 session").parentElement?.parentElement;
    expect(affected).toHaveTextContent("—");
    expect(affected).toHaveTextContent("占全部的 —");
    expect(screen.getByRole("link", { name: "出现工具失败" }).closest("div")).toHaveTextContent("——");
  });

  it("displays a known zero when tool outcomes are complete", async () => {
    renderStats({
      ...baseStats,
      toolRunCount: 1,
      toolOutcomeRunCount: 1,
      projects: [],
      daily: [],
      tokens: {},
      tokenRunCount: 0,
    });

    await screen.findByRole("heading", { name: "全局分析" });
    const failures = screen.getByText("工具失败").parentElement?.parentElement;
    expect(failures).toHaveTextContent("0");
    expect(failures).toHaveTextContent("1/1 个 session 的工具结果可判定。");
  });
});
