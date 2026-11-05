import { describe, it, expect } from "vitest";
import { McpBridge } from "./mcp-bridge.js";

describe("McpBridge", () => {
  it("delivers a call to a waiter already waiting", async () => {
    const bridge = new McpBridge();
    const waiting = bridge.waitForCall();
    const resultPromise = bridge.call("get_x", { a: 1 });
    const call = await waiting;
    expect(call.name).toBe("get_x");
    expect(call.arguments).toEqual({ a: 1 });
    bridge.deliverResult(call.id, { content: "ok", isError: false });
    await expect(resultPromise).resolves.toEqual({ content: "ok", isError: false });
  });

  it("queues a call made before anyone is waiting", async () => {
    const bridge = new McpBridge();
    const resultPromise = bridge.call("get_y", {});
    const call = await bridge.waitForCall();
    expect(call.name).toBe("get_y");
    bridge.deliverResult(call.id, { content: "y", isError: false });
    await expect(resultPromise).resolves.toEqual({ content: "y", isError: false });
  });

  it("rejects waitForCall when the signal aborts first", async () => {
    const bridge = new McpBridge();
    const controller = new AbortController();
    const waiting = bridge.waitForCall(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
  });

  it("times out an undelivered call with a synthetic error result", async () => {
    const bridge = new McpBridge();
    process.env.M365_MCP_CALL_TIMEOUT_MS = "20";
    try {
      const result = await bridge.call("slow", {});
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/timed out/i);
    } finally {
      delete process.env.M365_MCP_CALL_TIMEOUT_MS;
    }
  });

  it("setTools/listTools round-trip", () => {
    const bridge = new McpBridge();
    bridge.setTools([{ name: "t1" }]);
    expect(bridge.listTools()).toEqual([{ name: "t1" }]);
  });

  it("deliverResult on an unknown id is a harmless no-op", () => {
    const bridge = new McpBridge();
    expect(() => bridge.deliverResult("nonexistent", { content: "x" })).not.toThrow();
  });
});
