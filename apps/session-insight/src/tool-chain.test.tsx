import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SessionTools } from "./tool-chain";
import type { SessionRun, TraceSpan } from "./types";

const run: SessionRun = { id: "run-1", title: "工具调用测试" };

afterEach(() => cleanup());

function spans(): TraceSpan[] {
  const parent: TraceSpan = {
    id: "turn-1",
    type: "user",
    input: "请检查项目中的测试失败原因",
    startOffsetMs: 0,
  };
  const tools = Array.from({ length: 42 }, (_, index) => ({
    id: `tool-${index}`,
    parentId: "turn-1",
    type: "tool",
    tool: "bash",
    startOffsetMs: index + 1,
    durationMs: 120,
    input: index === 40 ? "target-input npm test" : `command-${index}`,
    output: index === 40 ? "target-output" : `output-${index}`,
    status: index === 0 ? "ok" : index === 1 ? "unknown" : "success",
  }));
  return [parent, ...tools];
}

describe("SessionTools", () => {
  it("filters calls, searches excerpts, and resets pagination", async () => {
    render(<MemoryRouter><SessionTools run={run} spans={spans()} openSpan={vi.fn()} /></MemoryRouter>);

    expect(screen.getByText("共 42 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("第 2 / 2 页")).toBeInTheDocument();
    expect(screen.getByText("target-input npm test")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("工具"), { target: { value: "bash" } });
    await waitFor(() => expect(screen.getByText("第 1 / 2 页")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("搜索输入/输出/错误"), { target: { value: "target-output" } });
    expect(screen.getByText("共 1 条")).toBeInTheDocument();
    expect(screen.getByText("target-input npm test")).toBeInTheDocument();
  });

  it("labels recorded success separately from an unconfirmed result", () => {
    render(<MemoryRouter><SessionTools run={run} spans={spans()} openSpan={vi.fn()} /></MemoryRouter>);

    expect(screen.getAllByText("成功").length).toBeGreaterThan(0);
    expect(screen.getAllByText("结果未判定").length).toBeGreaterThan(1);
    expect(screen.getByText("没有记录明确的成功或失败结果。")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("结果"), { target: { value: "unknown" } });
    expect(screen.getByText("共 1 条")).toBeInTheDocument();
    expect(screen.queryByText("成功")).not.toBeInTheDocument();
  });
});
