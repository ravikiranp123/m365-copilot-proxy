import { describe, it, expect, afterEach, vi } from "vitest";

// Controlled async-iterable stand-in for CopilotStream: lets the test push
// deltas and end the "turn" on cue, exactly mirroring how session.run()'s
// real stream is consumed by produceNative.
function makeControlledStream() {
  const queue: string[] = [];
  let resolveNext: ((r: IteratorResult<string>) => void) | null = null;
  let finished = false;
  let fullText = "";
  const iterator = {
    next(): Promise<IteratorResult<string>> {
      if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
      if (finished) return Promise.resolve({ value: undefined as any, done: true });
      return new Promise((res) => {
        resolveNext = res;
      });
    },
  };
  const stream = {
    [Symbol.asyncIterator]: () => iterator,
    get fullText() {
      return fullText;
    },
  };
  return {
    stream,
    push(s: string) {
      fullText += s;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: s, done: false });
      } else {
        queue.push(s);
      }
    },
    finish() {
      finished = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as any, done: true });
      }
    },
  };
}

const scripted: { stream: ReturnType<typeof makeControlledStream>["stream"] | null; runCalls: number } = {
  stream: null,
  runCalls: 0,
};

vi.mock("@m365-copilot/core", async (importActual) => {
  const actual = await importActual<typeof import("@m365-copilot/core")>();
  class FakeModelSession {
    turnCount = 0;
    conversationId = "conv-native-test";
    reset() {}
    newConversation() {
      this.conversationId = "conv-native-test-2";
      this.turnCount = 0;
    }
    async refreshAgent() {
      return false;
    }
    async run() {
      scripted.runCalls++;
      this.turnCount++;
      return scripted.stream;
    }
  }
  return { ...actual, ModelSession: FakeModelSession };
});

afterEach(() => {
  delete process.env.M365_ALLOW_NATIVE_TOOLS;
  scripted.stream = null;
  scripted.runCalls = 0;
});

describe("native MCP tool-calling bridge (M365_ALLOW_NATIVE_TOOLS=1)", () => {
  it("bridges one M365-native tool call across two harness requests, then returns the final answer", async () => {
    process.env.M365_ALLOW_NATIVE_TOOLS = "1";
    const { SessionPool, handleChatCompletion } = await import("./handler.js");
    const { mcpBridge } = await import("@m365-copilot/core");

    const ctrl = makeControlledStream();
    scripted.stream = ctrl.stream;

    const pool = new SessionPool();
    const tools = [{ type: "function", function: { name: "bash_tool", description: "run a command", parameters: { type: "object", properties: {} } } }];

    const body1 = { model: "claude-sonnet-5", stream: false, messages: [{ role: "user", content: "list the files" }], tools };
    const req1 = handleChatCompletion(body1 as any, pool, {});

    // Simulate M365's native connector hitting our MCP server mid-turn.
    const bridgeCallPromise = mcpBridge.call("bash_tool", { command: "ls" });

    const resp1 = await req1;
    expect(resp1.status).toBe(200);
    const json1: any = await resp1.json();
    expect(json1.choices[0].finish_reason).toBe("tool_calls");
    const toolCall = json1.choices[0].message.tool_calls[0];
    expect(toolCall.function.name).toBe("bash_tool");
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ command: "ls" });
    expect(scripted.runCalls).toBe(1); // one M365 turn covers the whole exchange

    // Harness executes the tool locally and reports back.
    const body2 = {
      ...body1,
      messages: [
        ...body1.messages,
        { role: "assistant", content: null, tool_calls: [toolCall] },
        { role: "tool", tool_call_id: toolCall.id, content: "file1.txt\nfile2.txt" },
      ],
    };
    const req2 = handleChatCompletion(body2 as any, pool, {});

    // Delivering the result unblocks the MCP server's held tools/call response.
    const bridgeResult = await bridgeCallPromise;
    expect(bridgeResult).toEqual({ content: "file1.txt\nfile2.txt", isError: false });

    // M365 finishes the turn with no further tool call.
    ctrl.push("Found 2 files.");
    ctrl.finish();

    const resp2 = await req2;
    const json2: any = await resp2.json();
    expect(json2.choices[0].finish_reason).toBe("stop");
    expect(json2.choices[0].message.content).toBe("Found 2 files.");
    expect(scripted.runCalls).toBe(1); // still just the one M365 turn
  });
});
