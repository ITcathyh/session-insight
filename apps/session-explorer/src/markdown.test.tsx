import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

afterEach(cleanup);

const html = (text: string) => {
  const { container } = render(<Markdown text={text} />);
  return container.querySelector(".md") as HTMLElement;
};

describe("Markdown", () => {
  it("renders headings, bold and inline code as elements", () => {
    const md = html("## 已探明的漂移\n\n**只改 src/agent/** 下的 `runner.js`");
    expect(md.querySelector("h4")?.textContent).toBe("已探明的漂移");
    expect(md.querySelector("strong")).not.toBeNull();
    expect(md.querySelector("code")?.textContent).toBe("runner.js");
    expect(md.textContent).not.toContain("##");
  });

  it("renders a pipe table as a real table", () => {
    const md = html(
      "| 项 | codex | coco |\n|---|---|---|\n| 错误类 | A | B |\n| 失败码 | C | D |",
    );
    expect(md.querySelectorAll("thead th")).toHaveLength(3);
    expect(md.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(md.textContent).not.toContain("|---|");
  });

  it("keeps fenced code verbatim without inline parsing", () => {
    const md = html("前言\n\n```js\nconst a = **not bold**;\n```");
    const pre = md.querySelector("pre.md-code");
    expect(pre?.textContent).toBe("const a = **not bold**;");
    expect(pre?.querySelector("strong")).toBeNull();
  });

  it("renders ordered and unordered lists", () => {
    const md = html("- 一\n- 二\n\n1. 甲\n2. 乙");
    expect(md.querySelectorAll("ul li")).toHaveLength(2);
    expect(md.querySelectorAll("ol li")).toHaveLength(2);
  });

  it("keeps soft line breaks inside a paragraph", () => {
    const md = html("第一行\n第二行");
    expect(md.querySelectorAll("br")).toHaveLength(1);
  });

  it("never turns transcript text into markup", () => {
    const md = html('<img src=x onerror="alert(1)"> 与 <b>粗体</b>');
    expect(md.querySelector("img")).toBeNull();
    expect(md.querySelector("b")).toBeNull();
    expect(md.textContent).toContain("<img src=x");
  });

  it("links only http(s) targets", () => {
    render(<Markdown text="见 https://example.com/a 和 [x](javascript:evil)" />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://example.com/a");
    expect(screen.getByText(/javascript:evil/)).toBeInTheDocument();
  });

  it("leaves snake_case identifiers alone", () => {
    const md = html("字段 file_path_name 未改名");
    expect(md.querySelector("em")).toBeNull();
    expect(md.textContent).toContain("file_path_name");
  });
});
