import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileRegistry } from "@m365-copilot/proxy-lib";

import { resolveModelRoute, resolveModelsPayload } from "./route-target.js";

const registry: ProfileRegistry = {
  profiles: {
    default: { port: 4141 },
    ato: { port: 4142 },
  },
};

describe("resolveModelRoute", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("serves the local profile's namespaced model locally", () => {
    vi.stubEnv("M365_PROFILE", "default");
    expect(resolveModelRoute("default/gpt-6.1-sol", registry)).toEqual({
      kind: "local",
      model: "gpt-6.1-sol",
    });
  });

  it("forwards another profile's namespaced model to its port", () => {
    vi.stubEnv("M365_PROFILE", "default");
    expect(resolveModelRoute("ato/gpt-6.1-sol", registry)).toEqual({
      kind: "forward",
      profile: "ato",
      port: 4142,
      model: "gpt-6.1-sol",
    });
  });

  it("accepts the legacy m365/<profile>/<model> form", () => {
    vi.stubEnv("M365_PROFILE", "default");
    expect(resolveModelRoute("m365/ato/claude-opus", registry)).toEqual({
      kind: "forward",
      profile: "ato",
      port: 4142,
      model: "claude-opus",
    });
  });

  it("leaves bare model IDs local", () => {
    vi.stubEnv("M365_PROFILE", "ato");
    expect(resolveModelRoute("gpt-6.1-sol", registry)).toEqual({
      kind: "local",
      model: "gpt-6.1-sol",
    });
  });

  it("reports an explicit prefix for an unregistered profile", () => {
    vi.stubEnv("M365_PROFILE", "default");
    expect(resolveModelRoute("m365/h2564/gpt-6.1-sol", registry)).toEqual({
      kind: "unknown-profile",
      profile: "h2564",
      model: "gpt-6.1-sol",
      known: ["default", "ato"],
    });
  });
});

describe("resolveModelsPayload", () => {
  afterEach(() => vi.unstubAllEnvs());

  const samplePayload = {
    object: "list" as const,
    data: [
      { id: "gpt-5.5", object: "model", created: 0, owned_by: "microsoft" },
      { id: "claude-sonnet", object: "model", created: 0, owned_by: "microsoft" },
    ],
  };

  const customRegistry: ProfileRegistry = {
    profiles: {
      default: { port: 4141, models: ["gpt-5.5"] },
      ato: { port: 4142 },
    },
  };

  it("returns only bare local models by default without cross-profile entries", () => {
    const out = resolveModelsPayload(samplePayload, "ato", customRegistry, false);
    expect(out.data.map((m) => m.id)).toEqual(["gpt-5.5", "claude-sonnet"]);
  });

  it("filters models if profile.models is configured", () => {
    const out = resolveModelsPayload(samplePayload, "default", customRegistry, false);
    expect(out.data.map((m) => m.id)).toEqual(["gpt-5.5"]);
  });

  it("adds cross-profile models when advertiseAll is true", () => {
    const out = resolveModelsPayload(samplePayload, "ato", customRegistry, true);
    expect(out.data.map((m) => m.id)).toEqual([
      "gpt-5.5",
      "claude-sonnet",
      "default/gpt-5.5",
      "default/claude-sonnet",
      "ato/gpt-5.5",
      "ato/claude-sonnet",
    ]);
  });

  it("respects M365_ADVERTISE_ALL_PROFILES env var", () => {
    vi.stubEnv("M365_ADVERTISE_ALL_PROFILES", "1");
    const out = resolveModelsPayload(samplePayload, "ato", customRegistry);
    expect(out.data.some((m) => m.id.startsWith("default/"))).toBe(true);
  });
});
