import { createLogger } from "./log.js";

const log = createLogger("mcp-bridge");

/** A pending promise with resolve/reject exposed (no Promise.withResolvers on
 *  our target engines). */
class Deferred<T> {
  resolve!: (value: T) => void;
  reject!: (err: unknown) => void;
  readonly promise: Promise<T>;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

export interface BridgeToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** One MCP tools/call M365's native orchestrator made against our sidecar. */
export interface BridgeCall {
  /** Internal correlation id (NOT the MCP JSON-RPC id — mcp-server.ts owns
   *  that). Used to match the eventual deliverResult() call. */
  id: string;
  name: string;
  arguments: unknown;
}

export interface BridgeResult {
  /** MCP tool result content, rendered as a single text block. */
  content: string;
  isError?: boolean;
}

const DEFAULT_CALL_TIMEOUT_MS = 170_000; // under M365's own per-turn ceiling

/**
 * Bridges Microsoft's native MCP tool-calling (a Copilot Studio agent's
 * connector invoking tools/call against our local MCP server — see
 * mcp-server.ts and scripts/mcp-sidecar/*) to the OpenAI-style tool_calls
 * round-trip the actual harness (pi, openclaw, ...) speaks over
 * /v1/chat/completions.
 *
 * Process-wide singleton, by design: one M365 identity (one Studio agent, one
 * connector endpoint) per proxy process, and this project's own convention is
 * to run ONE conversation at a time (AGENTS.md "Operating principles" #1 —
 * concurrent threads burn the account's thread-rate budget anyway). A second
 * concurrent bridged conversation in the same process would cross-wire calls;
 * that's an accepted v1 limitation, not a bug to route around.
 */
export class McpBridge {
  private tools: BridgeToolDefinition[] = [];
  private callQueue: BridgeCall[] = [];
  private waiters: Array<(call: BridgeCall) => void> = [];
  private pendingResults = new Map<string, Deferred<BridgeResult>>();

  setTools(tools: BridgeToolDefinition[]): void {
    this.tools = tools;
  }

  listTools(): BridgeToolDefinition[] {
    return this.tools;
  }

  /**
   * Called by the MCP HTTP server when M365's connector invokes a tool.
   * Resolves once the harness's real result comes back through
   * deliverResult() (via the proxy's native tool-call handler), or after
   * M365_MCP_CALL_TIMEOUT_MS with a synthetic error result so the connector
   * (and the M365 turn waiting on it) isn't left hanging forever.
   */
  async call(name: string, args: unknown): Promise<BridgeResult> {
    const id = crypto.randomUUID();
    const deferred = new Deferred<BridgeResult>();
    this.pendingResults.set(id, deferred);

    const bridgeCall: BridgeCall = { id, name, arguments: args };
    const waiter = this.waiters.shift();
    if (waiter) waiter(bridgeCall);
    else this.callQueue.push(bridgeCall);

    const timeoutMs = Number(process.env.M365_MCP_CALL_TIMEOUT_MS ?? DEFAULT_CALL_TIMEOUT_MS);
    const timeout = setTimeout(() => {
      if (this.pendingResults.delete(id)) {
        log.info(`tools/call ${name} (${id}) timed out after ${timeoutMs}ms waiting for the harness`);
        deferred.resolve({ content: "Tool call timed out waiting for the harness to execute it.", isError: true });
      }
    }, timeoutMs);
    try {
      return await deferred.promise;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Called by the native tool-call handler (handler.ts) to learn about the
   * next tool M365 wants to invoke. Resolves immediately if one is already
   * queued (M365's connector got there first); otherwise waits, and rejects
   * if `signal` aborts first (client disconnect).
   */
  waitForCall(signal?: AbortSignal): Promise<BridgeCall> {
    const queued = this.callQueue.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise<BridgeCall>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const onAbort = () => {
        const i = this.waiters.indexOf(onResolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("aborted"));
      };
      const onResolve = (call: BridgeCall) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(call);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(onResolve);
    });
  }

  /** Called by the native tool-call handler once the harness's tool result
   *  arrives in a later chat completion request. Unblocks the MCP server's
   *  held tools/call HTTP response, letting M365's turn continue. No-op (with
   *  a log) if the call already timed out or isn't recognized. */
  deliverResult(id: string, result: BridgeResult): void {
    const deferred = this.pendingResults.get(id);
    if (!deferred) {
      log.info(`deliverResult(${id}): no pending call (already timed out, or unknown id)`);
      return;
    }
    this.pendingResults.delete(id);
    deferred.resolve(result);
  }

  /** Diagnostic only: how many calls are queued/waited/in-flight. */
  get stats(): { queued: number; waiters: number; pending: number } {
    return { queued: this.callQueue.length, waiters: this.waiters.length, pending: this.pendingResults.size };
  }
}

/** Process-wide bridge. See the class doc for why this isn't per-conversation. */
export const mcpBridge = new McpBridge();
