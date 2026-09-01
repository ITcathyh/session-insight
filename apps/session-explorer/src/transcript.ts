/**
 * Unwraps the harness scaffolding that agent runtimes inject into conversation
 * turns, so the reader sees the message instead of its envelope.
 *
 * On this machine's recorded turns, 591 of them open with one of these shells:
 * `<teammate-message>`, `<task-notification>`, `<system-reminder>`,
 * `<command-name>`, `<local-command-*>`. Rendered verbatim they read as broken
 * output; worse, a turn that is *only* a `<system-reminder>` was being labelled
 * "用户", which claims the operator said something they never said.
 *
 * Unknown tags are deliberately left in the text. Inventing a friendly label
 * for a shell we have not seen would misreport what the log contains.
 */

export type TurnBlock =
  | { kind: "markdown"; text: string }
  /** A slash command the operator ran, e.g. `/model` or `/autocompact auto`. */
  | { kind: "command"; name: string; args?: string }
  /** Harness scaffolding, shown collapsed under its own label. */
  | { kind: "note"; label: string; text: string };

export type ParsedTurn = {
  /** Sender declared by the envelope, e.g. a teammate id. */
  from?: string;
  /** One-line subject the envelope supplied. */
  subject?: string;
  blocks: TurnBlock[];
  /** No human-authored content — only scaffolding. */
  harnessOnly: boolean;
};

const noteLabels: Record<string, string> = {
  "system-reminder": "系统提示",
  "local-command-caveat": "本地命令说明",
  "local-command-stdout": "本地命令输出",
  "kb-index": "知识库索引",
};

const shellSource =
  "<command-name>([\\s\\S]*?)</command-name>" +
  "\\s*(?:<command-message>[\\s\\S]*?</command-message>)?" +
  "\\s*(?:<command-args>([\\s\\S]*?)</command-args>)?" +
  "|<(system-reminder|local-command-caveat|local-command-stdout|kb-index|task-notification)>" +
  "([\\s\\S]*?)</\\3>";

/** Group 3 is greedy so it runs to the last closing tag; 4 keeps any tail
 *  (a `<system-reminder>` appended after the envelope is common). */
const envelopeSource =
  "^<(teammate-message|agent-message)([^>]*)>([\\s\\S]*)</\\1>([\\s\\S]*)$";

function attr(raw: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(raw);
  return match?.[1]?.trim() || undefined;
}

function innerTag(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match?.[1]?.trim() || undefined;
}

/** Machine payloads are far easier to scan pretty-printed than on one line. */
function prettyJSON(text: string): string | undefined {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed) || trimmed.length > 20000) return undefined;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return undefined;
  }
}

function textBlock(text: string): TurnBlock | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const json = prettyJSON(trimmed);
  return {
    kind: "markdown",
    text: json ? `\`\`\`json\n${json}\n\`\`\`` : trimmed,
  };
}

function taskNoteBlock(body: string): TurnBlock {
  const id = innerTag(body, "task-id");
  const summary = innerTag(body, "summary");
  const rest = body
    .replace(/<task-id>[\s\S]*?<\/task-id>/g, "")
    .replace(/<summary>[\s\S]*?<\/summary>/g, "")
    .replace(/<\/?event>/g, "")
    .trim();
  const json = prettyJSON(rest);
  const lines = [
    summary ? `**${summary}**` : undefined,
    json ? `\`\`\`json\n${json}\n\`\`\`` : rest || undefined,
  ].filter(Boolean);
  return {
    kind: "note",
    label: id ? `任务通知 · ${id}` : "任务通知",
    text: lines.join("\n\n"),
  };
}

export function parseTurn(raw: string): ParsedTurn {
  let text = (raw ?? "").trim();
  let from: string | undefined;
  let subject: string | undefined;

  const envelope = new RegExp(envelopeSource).exec(text);
  if (envelope) {
    from = attr(envelope[2], "teammate_id") ?? attr(envelope[2], "from");
    subject = attr(envelope[2], "summary");
    text = `${envelope[3].trim()}\n\n${envelope[4].trim()}`.trim();
  }

  const blocks: TurnBlock[] = [];
  const pattern = new RegExp(shellSource, "g");
  let last = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const before = textBlock(text.slice(last, m.index));
    if (before) blocks.push(before);
    if (m[1] !== undefined) {
      blocks.push({
        kind: "command",
        name: m[1].trim(),
        args: m[2]?.trim() || undefined,
      });
    } else if (m[3] === "task-notification") {
      blocks.push(taskNoteBlock(m[4]));
    } else {
      blocks.push({
        kind: "note",
        label: noteLabels[m[3]] ?? m[3],
        text: m[4].trim(),
      });
    }
    last = m.index + m[0].length;
  }
  const tail = textBlock(text.slice(last));
  if (tail) blocks.push(tail);

  return {
    from,
    subject,
    blocks,
    // A lone `/model` is still something the operator did, so only pure
    // scaffolding counts as harness-only.
    harnessOnly:
      blocks.length > 0 && blocks.every((block) => block.kind === "note"),
  };
}
