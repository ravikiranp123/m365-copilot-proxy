import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const sockets = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock("ws", () => ({
  default: class extends EventEmitter {
    static OPEN = 1;
    readyState = 1;

    constructor() {
      super();
      sockets.instances.push(this);
    }

    send() {}

    close() {
      this.readyState = 3;
      this.emit("close", 1000);
    }
  },
}));

import { CopilotSession } from "./session.js";

const token = `header.${Buffer.from(JSON.stringify({
  oid: "test-oid",
  tid: "test-tid",
  aud: "https://substrate.office.com/sydney",
  iss: "https://login.microsoftonline.com/test-tid/v2.0",
  exp: 4102444800,
})).toString("base64url")}.signature`;

afterEach(() => {
  sockets.instances.length = 0;
});

describe("CopilotSession connection lifecycle", () => {
  it("rejects instead of hanging when the socket closes before the handshake", async () => {
    const pending = new CopilotSession().chat(token, "hello", "claude-sonnet");
    const rejected = expect(pending).rejects.toThrow("WebSocket closed before handshake (code 1006)");
    sockets.instances[0].emit("close", 1006);
    await rejected;
  });

  it("preserves the abort reason when cancellation closes the socket before the handshake", async () => {
    const controller = new AbortController();
    const reason = new Error("client disconnected");
    const pending = new CopilotSession().chat(token, "hello", "claude-sonnet", controller.signal);
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
  });

  it("still completes a normal handshaken turn", async () => {
    const pending = new CopilotSession().chat(token, "hello", "claude-sonnet");
    const socket = sockets.instances[0];
    socket.emit("message", Buffer.from("{}\x1e"));
    const stream = await pending;
    socket.emit("message", Buffer.from('{"type":3,"invocationId":"0"}\x1e'));
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks).toEqual([]);
  });

  it("preserves connection errors rather than replacing them with a close error", async () => {
    const pending = new CopilotSession().chat(token, "hello", "claude-sonnet");
    const rejected = expect(pending).rejects.toThrow("WebSocket error: connection failed");
    const socket = sockets.instances[0];
    socket.emit("error", new Error("connection failed"));
    socket.emit("close", 1006);
    await rejected;
  });
});