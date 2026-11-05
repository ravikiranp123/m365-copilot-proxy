import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileRegistry } from "@m365-copilot/proxy-lib";

import { resolveModelRoute } from "./route-target.js";

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
