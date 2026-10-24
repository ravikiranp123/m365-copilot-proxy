import { afterEach, describe, expect, it } from "vitest";
import {
  buildSpecMap,
  deriveFencedSpec,
  formatFencedToolDefinitions,
  parseToolRequests,
  renderToolRequest,
} from "./fenced.js";
import { parseToolCalls, type ToolDef } from "./tools.js";

const fence = String.fromCharCode(96).repeat(3);
const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
];

afterEach(() => {
  delete process.env.M365_ACCEPT_LEGACY_JSON;
});

describe("TOOL_REQUEST protocol", () => {
  it("parses a delegated shell request", () => {
    const result = parseToolCalls("TOOL_REQUEST bash\nls -la", tools);
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls[0].function.name).toBe("bash");
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({
      command: "ls -la",
    });
  });

  it("parses M365's established whole-response shell fence by default", () => {
    const result = parseToolCalls(`${fence}bash\nls -la\n${fence}`, tools);
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls[0].function.name).toBe("bash");
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({
      command: "ls -la",
    });
  });

  it("parses a recognised shell fence with surrounding prose", () => {
    const markdown = ["Run with:", "", `${fence}bash`, "pnpm install", fence].join("\n");
    const result = parseToolCalls(markdown, tools);
    expect(result.hasToolCalls).toBe(true);
    expect(result.textContent).toBe("Run with:");
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: "pnpm install" });
  });

  it("preserves Markdown fences and EOF whitespace in a write body", () => {
    const body = ["# Setup", "", `${fence}bash`, "pnpm install", fence, "", "  ", ""].join("\n");
    const result = parseToolCalls(
      `TOOL_REQUEST write_file\npath: README.md\n\n${body}`,
      tools,
    );
    expect(result.hasToolCalls).toBe(true);
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({
      path: "README.md",
      content: body,
    });
  });

  it("parses multiple fences for the handler to apply its single-operation limit", () => {
    const markdown = `${fence}bash\nls\n${fence}\n${fence}bash\npwd\n${fence}`;
    expect(parseToolCalls(markdown, tools).toolCalls).toHaveLength(2);
  });

  it("treats legacy JSON as content unless explicitly enabled", () => {
    const json = '{"tool":"bash","arguments":{"command":"ls"}}';
    expect(parseToolCalls(json, tools).hasToolCalls).toBe(false);
    process.env.M365_ACCEPT_LEGACY_JSON = "1";
    expect(parseToolCalls(json, tools).hasToolCalls).toBe(true);
  });

  it("does not accept a request marker after prose", () => {
    const result = parseToolCalls(
      "For example:\n\nTOOL_REQUEST bash\necho not-run",
      tools,
    );
    expect(result.hasToolCalls).toBe(false);
  });

  it("does not accept an unavailable operation", () => {
    const result = parseToolCalls("TOOL_REQUEST delete_everything\n/", tools);
    expect(result.hasToolCalls).toBe(false);
  });

  it("preserves commentary around an operation without requiring a flag", () => {
    const result = parseToolCalls(`I will inspect the project.\n${fence}bash\npwd\n${fence}\nThen I can choose the next step.`, tools);
    expect(result.hasToolCalls).toBe(true);
    expect(result.textContent).toContain("I will inspect the project.");
    expect(result.textContent).toContain("Then I can choose the next step.");
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: "pwd" });
  });

  it("round-trips request rendering with Markdown content", () => {
    const content = `# Hi\n\n${fence}bash\necho hi\n${fence}`;
    const rendered = renderToolRequest(deriveFencedSpec(tools[1]), {
      path: "README.md",
      content,
    });
    const parsed = parseToolRequests(rendered, buildSpecMap(tools));
    expect(JSON.parse(parsed.calls[0].function.arguments)).toEqual({
      path: "README.md",
      content,
    });
  });

  it("uses delegated wording without claiming tool ownership", () => {
    const prompt = formatFencedToolDefinitions(tools, "baseline");
    expect(prompt).toContain("I will run it manually");
    expect(prompt).toContain("```bash");
    expect(prompt).toContain("TOOL_REQUEST <tool_name>");
    expect(prompt).toContain("not required for Markdown writes");
    expect(prompt).toContain("outer backtick fence is longer");
    expect(prompt).toContain("Document detection is only a best-effort safeguard");
    expect(prompt).not.toContain("You have a real shell");
  });
});
