// A synthetic Codex session large enough to exercise the trace workbench:
// virtualized tree, telemetry folding, failure navigation, conversation
// paging, and compare. It replaces the machine-specific rollout file the
// suite used to read from a hard-coded absolute path, so the suite now runs
// anywhere.
//
// Every number the spec asserts on is derived here and exported, so the
// fixture and its assertions cannot drift apart.

const USER_TURNS = 24;
const AGENT_RESPONSES = 61;
const REASONING_EVENTS = 269;
const TOKEN_PULSES = 270;
const TOOL_EVENTS = 385;
const SUBAGENT_EVENTS = 1;

// One idle marker per gap longer than the parser's 5-minute threshold. The
// loop below opens one on every fifth turn.
const IDLE_GAP_TURNS = [5, 10, 15, 20];
const IDLE_EVENTS = IDLE_GAP_TURNS.length;
// The parser emits a "User correction candidate" alongside the user turn whose
// wording it flags. Exactly one prompt below is worded to trigger it.
const CORRECTION_EVENTS = 1;

/**
 * Total TraceEvents the parser derives from this fixture — emitted events plus
 * the two kinds the parser derives on its own.
 */
export const CODEX_TRACE_EVENTS =
  USER_TURNS +
  AGENT_RESPONSES +
  REASONING_EVENTS +
  TOKEN_PULSES +
  TOOL_EVENTS +
  SUBAGENT_EVENTS +
  IDLE_EVENTS +
  CORRECTION_EVENTS;

export const CODEX_SESSION_ID = "e2e-codex-flagship";
export const CODEX_TITLE = "梳理 token 归因链路";
export const CODEX_MODEL = "codex-e2e-large";
export const CODEX_USER_TURNS = USER_TURNS;
export const CODEX_AGENT_TURNS = AGENT_RESPONSES;

// tracked = (input − cached) + cached + cacheWrite + output = input + cacheWrite + output.
// The cached component cancels out, so only these three set the total.
const FINAL_INPUT = 20_000_000;
const FINAL_CACHE_WRITE = 44_000;
const FINAL_OUTPUT = 4_000_000;
/** 24,044,000 rendered by Intl compact zh-CN. */
export const CODEX_TRACKED_TOKENS_LABEL = "2404.4万";

const CONTEXT_WINDOW = 400_000;
const PEAK_CONTEXT = 360_000;
export const CODEX_CONTEXT_PEAK_LABEL = "90%";

/** Failure count: one bash, two apply_patch. Compare asserts on the bash row. */
export const CODEX_BASH_CALLS = 1;
export const CODEX_BASH_FAILURES = 1;

const START = Date.parse("2026-08-29T09:00:00Z");

// Spread a total across `buckets` as evenly as possible, remainder first, so
// the counts stay deterministic and sum exactly to the total.
function spread(total: number, buckets: number): number[] {
  const base = Math.floor(total / buckets);
  const extra = total % buckets;
  return Array.from({ length: buckets }, (_, i) => base + (i < extra ? 1 : 0));
}

const agentPerTurn = spread(AGENT_RESPONSES, USER_TURNS);
const reasoningPerTurn = spread(REASONING_EVENTS, USER_TURNS);
const pulsePerTurn = spread(TOKEN_PULSES, USER_TURNS);
const toolsPerTurn = spread(TOOL_EVENTS, USER_TURNS);

const TOOL_NAMES = [
  "command_execution",
  "read_file",
  "apply_patch",
  "search",
  "command_execution",
  "write_file",
];

const prompts = [
  CODEX_TITLE,
  // Turn 2 onward can register a correction; this one deliberately does.
  "instead 先把失败的工具挑出来，别继续往下走",
  "继续，把上下文压力最高的那几轮标出来",
  "这轮先看缓存命中率",
];

type Line = Record<string, unknown>;

/**
 * Builds the JSONL body. Emitted in the pre-canonical Codex shape
 * (`event_msg` + `response_item`), which is what the modern.jsonl unit
 * fixture uses, so both suites exercise the same parser path.
 */
export function buildCodexSession(sessionId = CODEX_SESSION_ID): string {
  const lines: Line[] = [];
  let clock = START;
  let pulseIndex = 0;
  let callIndex = 0;
  let bashEmitted = false;
  let patchFailures = 0;

  const at = (stepMs = 1_000) => {
    clock += stepMs;
    return new Date(clock).toISOString();
  };

  lines.push({
    timestamp: new Date(clock).toISOString(),
    type: "session_meta",
    payload: {
      id: sessionId,
      type: "session_meta",
      cwd: "/workspace/session-explorer",
      model: CODEX_MODEL,
    },
  });

  for (let turn = 0; turn < USER_TURNS; turn += 1) {
    // Idle gaps every few turns: the parser splits wall time into active and
    // idle at a 5-minute threshold, and the UI shows both.
    const gap = turn > 0 && turn % 5 === 0 ? 11 * 60_000 : 2_000;
    lines.push({
      timestamp: at(gap),
      type: "event_msg",
      payload: {
        type: "user_message",
        message: prompts[turn] ?? `${prompts[3]}（第 ${turn + 1} 轮）`,
      },
    });

    for (let i = 0; i < reasoningPerTurn[turn]; i += 1) {
      lines.push({
        timestamp: at(400),
        type: "response_item",
        payload: { type: "reasoning" },
      });
    }

    for (let i = 0; i < toolsPerTurn[turn]; i += 1) {
      callIndex += 1;
      const callId = `call-${callIndex}`;
      let name = TOOL_NAMES[callIndex % TOOL_NAMES.length];
      let exitCode = 0;

      // Exactly one bash call, and it fails — compare asserts on that row.
      if (!bashEmitted && turn === 1 && i === 2) {
        name = "bash";
        exitCode = 1;
        bashEmitted = true;
      } else if (name === "apply_patch" && patchFailures < 2 && turn > 3) {
        exitCode = 2;
        patchFailures += 1;
      }

      lines.push({
        timestamp: at(600),
        type: "response_item",
        payload: {
          type: "function_call",
          name,
          call_id: callId,
          arguments: JSON.stringify({
            command: `${name} --target packages/session-${callIndex}`,
          }),
        },
      });
      lines.push({
        timestamp: at(900),
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({
            exit_code: exitCode,
            stdout:
              exitCode === 0
                ? `ok: ${name} finished for step ${callIndex}`
                : "",
            stderr: exitCode === 0 ? "" : `${name} exited ${exitCode}`,
          }),
        },
      });
    }

    if (turn === 6) {
      lines.push({
        timestamp: at(500),
        type: "event_msg",
        payload: {
          type: "sub_agent_activity",
          kind: "started",
          event_id: "subagent-1",
        },
      });
    }

    for (let i = 0; i < agentPerTurn[turn]; i += 1) {
      lines.push({
        timestamp: at(1_200),
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: `第 ${turn + 1} 轮结论 ${i + 1}：已核对 ${toolsPerTurn[turn]} 次工具调用，其中失败会在时间轴上标红。\n\n- 缓存命中率随轮次上升\n- 上下文压力在中段达到峰值`,
        },
      });
    }

    for (let i = 0; i < pulsePerTurn[turn]; i += 1) {
      pulseIndex += 1;
      const progress = pulseIndex / TOKEN_PULSES;
      const input = Math.round(FINAL_INPUT * progress);
      const cached = Math.floor(input * 0.7);
      const cacheWrite = Math.round(FINAL_CACHE_WRITE * progress);
      const output = Math.round(FINAL_OUTPUT * progress);
      // Context occupancy rises to a single peak at pulse 200, then falls —
      // peak/window is what the UI reports, so exactly one pulse hits 90%.
      const context =
        pulseIndex === 200
          ? PEAK_CONTEXT
          : 90_000 + ((pulseIndex * 7_919) % 180_000);
      lines.push({
        timestamp: at(300),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              cache_write_input_tokens: cacheWrite,
              output_tokens: output,
              reasoning_output_tokens: Math.round(output * 0.4),
              total_tokens: input + output,
            },
            last_token_usage: { total_tokens: context },
            model_context_window: CONTEXT_WINDOW,
          },
        },
      });
    }
  }

  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

export function codexSessionUpload(sessionId = CODEX_SESSION_ID) {
  return {
    name: `${sessionId}.jsonl`,
    mimeType: "application/json",
    buffer: Buffer.from(buildCodexSession(sessionId)),
  };
}
