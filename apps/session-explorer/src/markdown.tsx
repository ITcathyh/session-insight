/**
 * A small Markdown renderer for transcript bodies.
 *
 * Session text is written by agents, and on this machine's 11311 recorded
 * conversation turns 33% contain inline code, 19% bold, 12% headings, 9% lists
 * and 6% pipe tables. Showing that as plain text — literal `##`, `**` and
 * `|---|---|` rows — is the single biggest readability problem in the viewer.
 *
 * It renders to React elements, never to HTML strings, so transcript content
 * can never inject markup. Only http(s) links become anchors.
 */
import { Fragment, type ReactNode } from "react";

/** Ordered alternation: `**` must be tried before `*`, links before bare URLs. */
const inlineSource =
  "(`+)([\\s\\S]*?)\\1" + // 1,2  code span
  "|\\*\\*([^\\n]+?)\\*\\*" + // 3    bold
  "|~~([^\\n]+?)~~" + // 4    strikethrough
  "|(?<![\\w*])\\*([^*\\n]+?)\\*(?![\\w*])" + // 5    italic
  "|\\[([^\\]\\n]*)\\]\\((https?://[^\\s)]+)\\)" + // 6,7  link
  "|(https?://[^\\s<>()\\[\\]]+)"; // 8    bare URL

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = new RegExp(inlineSource, "g");
  let last = 0;
  let key = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `n${key++}`;
    if (m[2] !== undefined) out.push(<code key={k}>{m[2].trim()}</code>);
    else if (m[3] !== undefined)
      out.push(<strong key={k}>{renderInline(m[3])}</strong>);
    else if (m[4] !== undefined) out.push(<del key={k}>{renderInline(m[4])}</del>);
    else if (m[5] !== undefined) out.push(<em key={k}>{renderInline(m[5])}</em>);
    else if (m[7] !== undefined)
      out.push(
        <a key={k} href={m[7]} target="_blank" rel="noreferrer noopener">
          {m[6] || m[7]}
        </a>,
      );
    else if (m[8] !== undefined)
      out.push(
        <a key={k} href={m[8]} target="_blank" rel="noreferrer noopener">
          {m[8]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Soft line breaks are meaningful in prompts, so they survive as <br />. */
function withBreaks(text: string): ReactNode[] {
  return text.split("\n").flatMap((line, index) =>
    index === 0
      ? renderInline(line)
      : [<br key={`br${index}`} />, ...renderInline(line)],
  );
}

const headingRe = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const fenceRe = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const ruleRe = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const quoteRe = /^ {0,3}>\s?/;
const bulletRe = /^(\s*)([-*+])\s+(.*)$/;
const orderedRe = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const tableRowRe = /^\s*\|.*\|\s*$/;
const tableDivRe = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

function isBlockStart(line: string): boolean {
  return (
    headingRe.test(line) ||
    fenceRe.test(line) ||
    ruleRe.test(line) ||
    quoteRe.test(line) ||
    bulletRe.test(line) ||
    orderedRe.test(line) ||
    tableRowRe.test(line)
  );
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

type ListItem = { lines: string[] };

/** Collect one list, returning its items plus the index just past the list. */
function takeList(
  lines: string[],
  start: number,
  ordered: boolean,
): { items: ListItem[]; next: number } {
  const re = ordered ? orderedRe : bulletRe;
  const base = (re.exec(lines[start]) as RegExpExecArray)[1].length;
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const match = re.exec(line);
    if (match && match[1].length === base) {
      items.push({ lines: [match[3]] });
      i += 1;
      continue;
    }
    // Deeper markers and indented text belong to the item we are inside.
    const indented = /^\s+\S/.test(line) && items.length > 0;
    if (indented) {
      items[items.length - 1].lines.push(line.replace(/^ {1,4}/, ""));
      i += 1;
      continue;
    }
    if (!line.trim() && items.length > 0) {
      const after = lines[i + 1] ?? "";
      if (re.test(after) || /^\s+\S/.test(after)) {
        items[items.length - 1].lines.push("");
        i += 1;
        continue;
      }
    }
    break;
  }
  return { items, next: i };
}

/** Item bodies are usually a single line; don't wrap those in a paragraph. */
function itemContent(item: ListItem): ReactNode {
  const text = item.lines.join("\n").trim();
  if (!text) return null;
  if (!text.includes("\n") && !isBlockStart(text)) return renderInline(text);
  return <>{parseBlocks(text.split("\n"))}</>;
}

function parseBlocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const push = (node: ReactNode) => {
    out.push(<Fragment key={`b${key++}`}>{node}</Fragment>);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = fenceRe.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !fenceRe.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or end of input)
      push(
        <pre className="md-code" data-lang={fence[2] || undefined}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (ruleRe.test(line)) {
      push(<hr />);
      i += 1;
      continue;
    }

    const heading = headingRe.exec(line);
    if (heading) {
      const level = heading[1].length;
      // Shift down two levels: the page already owns h1/h2.
      const Tag = `h${Math.min(level + 2, 6)}` as "h3" | "h4" | "h5" | "h6";
      push(
        <Tag className={`md-h md-h${level}`}>{renderInline(heading[2])}</Tag>,
      );
      i += 1;
      continue;
    }

    if (quoteRe.test(line)) {
      const body: string[] = [];
      while (i < lines.length && quoteRe.test(lines[i])) {
        body.push(lines[i].replace(quoteRe, ""));
        i += 1;
      }
      push(<blockquote>{parseBlocks(body)}</blockquote>);
      continue;
    }

    if (tableRowRe.test(line) && tableDivRe.test(lines[i + 1] ?? "")) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && tableRowRe.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      push(
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {head.map((cell, index) => (
                  <th key={index}>{renderInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {head.map((_, cellIndex) => (
                    <td key={cellIndex}>{renderInline(row[cellIndex] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const ordered = orderedRe.test(line);
    if (ordered || bulletRe.test(line)) {
      const { items, next } = takeList(lines, i, ordered);
      i = next;
      const children = items.map((item, index) => (
        <li key={index}>{itemContent(item)}</li>
      ));
      push(
        ordered ? (
          <ol className="md-list">{children}</ol>
        ) : (
          <ul className="md-list">{children}</ul>
        ),
      );
      continue;
    }

    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      body.push(lines[i]);
      i += 1;
    }
    if (!body.length) {
      // Defensive: a line that claims to start a block but matched nothing
      // above would otherwise loop forever.
      body.push(lines[i]);
      i += 1;
    }
    push(<p>{withBreaks(body.join("\n"))}</p>);
  }

  return out;
}

export function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return (
    <div className={className ? `md ${className}` : "md"}>
      {parseBlocks(lines)}
    </div>
  );
}
