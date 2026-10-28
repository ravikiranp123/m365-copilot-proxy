import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { defaultTarget, getModels, main, normalizeModels, parseOptions, updateConfig } from "./sync-models.mjs";

const directories = [];
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "m365-sync-test-"));
  directories.push(directory);
  return directory;
};
const models = [
  { id: "gpt-5.5-think-deeper", context_window: 1000000, max_output_tokens: 64000 },
  { id: "claude-sonnet-think-deeper", context_window: 200000, max_output_tokens: 32000 },
];
const options = { client: "opencode", port: "4141", quiet: true };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("model synchronization options", () => {
  it("keeps Pi as the default and supports existing flags", () => {
    expect(parseOptions(["--local", "--offline", "-q"], {})).toMatchObject({
      client: "pi", port: "4141", local: true, offline: true, quiet: true,
    });
  });

  it("supports OpenCode and environment ports", () => {
    expect(parseOptions(["--client", "opencode"], { PORT: "4242" })).toMatchObject({
      client: "opencode", port: "4242",
    });
  });

  it.each([
    ["--client", "unknown"],
    ["--port", "0"],
    ["--port", "65536"],
    ["--port", "4141oops"],
    ["--target"],
    ["--unknown"],
    ["--local", "--target", "somewhere"],
  ])("rejects invalid arguments %j", (...args) => {
    expect(() => parseOptions(args, {})).toThrow();
  });

  it("honors XDG configuration and selects existing JSONC", () => {
    const directory = temporaryDirectory();
    const configDirectory = join(directory, "opencode");
    mkdirSync(configDirectory);
    const jsonc = join(configDirectory, "opencode.jsonc");
    writeFileSync(jsonc, "{}");
    expect(defaultTarget(options, { XDG_CONFIG_HOME: directory }, "/unused")).toBe(jsonc);
    writeFileSync(join(configDirectory, "opencode.json"), "{}");
    expect(() => defaultTarget(options, { XDG_CONFIG_HOME: directory }, "/unused")).toThrow(/Both/);
  });
});

describe("configuration updates", () => {
  it("creates an OpenCode-compatible provider", () => {
    const result = parse(updateConfig("{}\n", models, options));
    expect(result.provider.m365).toMatchObject({
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:4141/v1", apiKey: "m365" },
    });
    expect(result.provider.m365.models[models[0].id]).toMatchObject({
      tool_call: true,
      limit: { context: 1000000, output: 64000 },
    });
  });

  it("preserves credentials, URLs, settings, other providers and model overrides", () => {
    const source = {
      model: "m365/gpt-5.5-think-deeper",
      plugin: ["example-plugin"],
      provider: {
        other: { npm: "example", models: {} },
        m365: {
          name: "My M365",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "{env:MY_KEY}", baseURL: "http://localhost:9999/v1", timeout: false },
          models: {
            "gpt-5.5-think-deeper": {
              name: "Custom name", tool_call: false,
              limit: { context: 120000, output: 8000 },
              options: { custom: true },
            },
            retired: { name: "Remove me" },
          },
        },
      },
    };
    const result = parse(updateConfig(JSON.stringify(source), models, options));
    expect(result.model).toBe(source.model);
    expect(result.plugin).toEqual(source.plugin);
    expect(result.provider.other).toEqual(source.provider.other);
    expect(result.provider.m365.options).toEqual(source.provider.m365.options);
    expect(result.provider.m365.models[models[0].id]).toEqual(source.provider.m365.models[models[0].id]);
    expect(result.provider.m365.models.retired).toBeUndefined();
  });

  it("preserves JSONC comments outside the model catalogue", () => {
    const source = '{\n  // keep this comment\n  "provider": {\n    "other": {},\n  },\n}\n';
    const result = updateConfig(source, models, options);
    expect(result).toContain("// keep this comment");
    expect(parse(result).provider.other).toEqual({});
    expect(updateConfig(result, models, options)).toBe(result);
  });

  it("keeps the Pi format and model overrides", () => {
    const source = JSON.stringify({
      providers: {
        other: { models: [] },
        m365: { apiKey: "existing", models: [{ id: models[0].id, name: "Mine", contextWindow: 120000 }] },
      },
    });
    const result = parse(updateConfig(source, models, { ...options, client: "pi" }));
    expect(result.providers.other).toEqual({ models: [] });
    expect(result.providers.m365.apiKey).toBe("existing");
    expect(result.providers.m365.models[0]).toMatchObject({ name: "Mine", contextWindow: 120000 });
    expect(Array.isArray(result.providers.m365.models)).toBe(true);
  });

  it.each(["{broken", "null", "[]", '{"provider":[]}', '{"provider":{"m365":null}}'])(
    "rejects malformed or structurally invalid configuration: %s", (source) => {
      expect(() => updateConfig(source, models, options)).toThrow();
    },
  );

  it.each([[], [null], [""], [" x "], ["duplicate", "duplicate"], [{ id: "x", max_output_tokens: -1 }]])(
    "rejects invalid catalogues: %j", (catalogue) => {
      expect(() => normalizeModels(catalogue)).toThrow();
    },
  );

  it("handles special object-key model IDs without prototype mutation", () => {
    const result = JSON.parse(updateConfig("{}", ["__proto__", "constructor"], options));
    expect(Object.keys(result.provider.m365.models)).toEqual(["__proto__", "constructor"]);
    expect(result.provider.m365.models.constructor.name).toBe("Constructor");
    expect(Object.getPrototypeOf(result.provider.m365.models)).toBe(Object.prototype);
  });
});

describe("discovery and safe file writes", () => {
  it("uses live endpoint metadata", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: models }) });
    vi.stubGlobal("fetch", fetch);
    expect(await getModels(options)).toEqual(models);
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:4141/v1/models");
  });

  it("rejects an invalid successful endpoint response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }));
    await expect(getModels(options)).rejects.toThrow(/non-empty/);
  });

  it("falls back to the built core when the endpoint is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const result = await getModels(options);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].context_window).toBeGreaterThan(0);
  });

  it("does not use HTTP in offline mode", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await getModels({ ...options, offline: true })).length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("writes only the explicit temporary target and is repeatable", async () => {
    const target = join(temporaryDirectory(), "nested", "opencode.json");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: models }) }));
    const args = ["--client", "opencode", "--target", target, "--quiet"];
    await main(args);
    const first = readFileSync(target, "utf8");
    await main(args);
    expect(readFileSync(target, "utf8")).toBe(first);
    expect(Object.keys(parse(first).provider.m365.models)).toHaveLength(2);
  });

  it("never overwrites malformed configuration", async () => {
    const target = join(temporaryDirectory(), "opencode.json");
    const original = "{broken";
    writeFileSync(target, original);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: models }) }));
    await expect(main(["--client", "opencode", "--target", target, "-q"])).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe(original);
  });
});
