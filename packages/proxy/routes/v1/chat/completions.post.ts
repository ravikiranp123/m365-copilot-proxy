import { ChatCompletionRequest, handleChatCompletion } from "@m365-copilot/proxy-lib";
import { pool } from "../../../server-pool";
import { resolveModelRoute } from "../../../lib/route-target";

export default defineEventHandler(async (event) => {
  // Keep the raw body for forwarding: the zod schema strips keys it doesn't
  // know, and a profile's own proxy should see the request the client sent.
  const raw = await readBody(event);

  let body: ReturnType<typeof ChatCompletionRequest.parse>;
  try {
    body = ChatCompletionRequest.parse(raw);
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Propagate client disconnects as an AbortSignal so a long M365 turn gets
  // cancelled (Stop frame) instead of running on after the caller gave up.
  // Only abort on a *premature* close — guard with the response "finish" event
  // so a normal keep-alive socket close after a completed response is ignored.
  const ac = new AbortController();
  const req = event.node?.req;
  const res = event.node?.res;
  if (req && res) {
    let finished = false;
    res.once("finish", () => { finished = true; });
    const maybeAbort = () => { if (!finished && !res.writableEnded) ac.abort(); };
    req.once("close", maybeAbort);
    res.once("close", maybeAbort);
  }

  let route: ReturnType<typeof resolveModelRoute>;
  try {
    route = resolveModelRoute(body.model);
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: { message: `Profile registry is unreadable: ${err.message}`, type: "invalid_request_error" },
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  if (route.kind === "unknown-profile") {
    return new Response(
      JSON.stringify({
        error: {
          message: `Unknown profile "${route.profile}". Known profiles: ${route.known.join(", ") || "(none)"}. Add it with \`pnpm profiles add ${route.profile}\`.`,
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (route.kind === "forward") {
    // One base URL serves every account: hand the request to the proxy that
    // owns this profile's credentials, with the prefix stripped.
    const url = `http://127.0.0.1:${route.port}/v1/chat/completions`;
    const requestHeaders: Record<string, string> = { "Content-Type": "application/json" };
    // The proxy is unauthenticated today, but forward a caller's bearer token
    // if one is ever added in front of it.
    const authorization = event.node?.req?.headers.authorization;
    if (authorization) requestHeaders.Authorization = authorization;

    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ ...raw, model: route.model }),
        signal: ac.signal,
      });
    } catch (err: any) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Profile "${route.profile}" is not reachable on port ${route.port} (${err.message}). Start it with \`pnpm profiles start ${route.profile}\`.`,
            type: "m365_profile_unreachable",
          },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }

    // Stream through untouched: SSE chunks, status, and content type are the
    // upstream proxy's, so a harness sees exactly what it would have seen had
    // it called that port directly.
    const headers = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType) headers.set("Content-Type", contentType);
    headers.set("X-M365-Profile", route.profile);
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  // handleChatCompletion returns a Web Response (JSON or an SSE ReadableStream
  // when stream:true). Returning it directly lets h3 forward it untouched.
  return handleChatCompletion({ ...body, model: route.model }, pool, { signal: ac.signal });
});
