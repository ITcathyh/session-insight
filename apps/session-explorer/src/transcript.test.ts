import { describe, expect, it } from "vitest";
import { parseTurn } from "./transcript";

describe("parseTurn", () => {
  it("unwraps a teammate envelope into sender, subject and body", () => {
    const turn = parseTurn(
      '<teammate-message teammate_id="team-lead" summary="W1c: agent runner 契约统一">\n项目:/tmp/bot。先读 AGENTS.md。\n</teammate-message>',
    );
    expect(turn.from).toBe("team-lead");
    expect(turn.subject).toBe("W1c: agent runner 契约统一");
    expect(turn.blocks).toEqual([
      { kind: "markdown", text: "项目:/tmp/bot。先读 AGENTS.md。" },
    ]);
    expect(turn.harnessOnly).toBe(false);
  });

  it("keeps content that follows the envelope", () => {
    const turn = parseTurn(
      '<teammate-message teammate_id="lead">干活</teammate-message>\n<system-reminder>其他 agent: main</system-reminder>',
    );
    expect(turn.blocks).toEqual([
      { kind: "markdown", text: "干活" },
      { kind: "note", label: "系统提示", text: "其他 agent: main" },
    ]);
  });

  it("marks a turn that is only scaffolding as harness-only", () => {
    const turn = parseTurn(
      "<system-reminder>\nOther agents active: main, w1a.\n</system-reminder>",
    );
    expect(turn.harnessOnly).toBe(true);
    expect(turn.blocks[0]).toEqual({
      kind: "note",
      label: "系统提示",
      text: "Other agents active: main, w1a.",
    });
  });

  it("treats a slash command as something the operator did", () => {
    const turn = parseTurn(
      "<command-name>/autocompact</command-name>\n  <command-message>autocompact</command-message>\n  <command-args>auto</command-args>",
    );
    expect(turn.blocks).toEqual([
      { kind: "command", name: "/autocompact", args: "auto" },
    ]);
    expect(turn.harnessOnly).toBe(false);
  });

  it("summarises a task notification by id and subject", () => {
    const turn = parseTurn(
      '<task-notification><task-id>brtlf37</task-id><summary>Monitor event</summary><event>{"event":"send_attempt_started"}</event></task-notification>',
    );
    const [block] = turn.blocks;
    expect(block).toMatchObject({ kind: "note", label: "任务通知 · brtlf37" });
    expect(block.kind === "note" && block.text).toContain("**Monitor event**");
    expect(block.kind === "note" && block.text).toContain(
      '"event": "send_attempt_started"',
    );
  });

  it("pretty-prints a JSON-only body", () => {
    const turn = parseTurn(
      '<teammate-message teammate_id="lead">{"type":"task_assignment","taskId":"1"}</teammate-message>',
    );
    expect(turn.blocks[0]).toEqual({
      kind: "markdown",
      text: '```json\n{\n  "type": "task_assignment",\n  "taskId": "1"\n}\n```',
    });
  });

  it("leaves an unrecognised tag in the text rather than guessing a label", () => {
    const turn = parseTurn("<mystery-shell>内容</mystery-shell>");
    expect(turn.blocks).toEqual([
      { kind: "markdown", text: "<mystery-shell>内容</mystery-shell>" },
    ]);
    expect(turn.harnessOnly).toBe(false);
  });
});
