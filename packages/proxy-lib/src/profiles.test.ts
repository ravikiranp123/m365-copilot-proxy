import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  resolveDataDir,
  splitProfileModel,
  withProfileModels,
} from "./profiles.js";

describe("profile model IDs", () => {
  it("splits the explicit m365/<profile>/<model> form even for an unknown profile", () => {
    expect(splitProfileModel("m365/ato/gpt-6.1-sol", [])).toEqual({
      profile: "ato",
      model: "gpt-6.1-sol",
    });
  });

  it("splits the bare <profile>/<model> form only for a known profile", () => {
    expect(splitProfileModel("ato/gpt-6.1-sol", ["ato"])).toEqual({
      profile: "ato",
      model: "gpt-6.1-sol",
    });
    expect(splitProfileModel("someone/gpt-6.1-sol", ["ato"])).toEqual({
      model: "someone/gpt-6.1-sol",
    });
  });

  it("leaves an unprefixed model alone", () => {
    expect(splitProfileModel("gpt-6.1-sol", ["ato"])).toEqual({ model: "gpt-6.1-sol" });
    expect(splitProfileModel("claude-opus-5[1m]", ["ato"])).toEqual({ model: "claude-opus-5[1m]" });
  });
});

describe("profile data dirs", () => {
  it("expands ~ and resolves relative paths against the repo root", () => {
    expect(resolveDataDir("~")).toBe(homedir());
    expect(resolveDataDir("~/.config/opencode-m365")).toBe(
      resolve(homedir(), ".config/opencode-m365"),
    );
    expect(resolveDataDir(".m365-profiles/h2564")).toBe(resolve(".m365-profiles/h2564"));
  });
});

describe("withProfileModels", () => {
  const payload = {
    object: "list" as const,
    data: [
      { id: "gpt-6.1-sol", object: "model", created: 1, owned_by: "microsoft" },
      { id: "claude-sonnet", object: "model", created: 1, owned_by: "microsoft" },
    ],
  };

  it("keeps bare IDs and adds one namespaced copy per profile", () => {
    const out = withProfileModels(payload, ["default", "ato"]);
    expect(out.data.map((m) => m.id)).toEqual([
      "gpt-6.1-sol",
      "claude-sonnet",
      "default/gpt-6.1-sol",
      "default/claude-sonnet",
      "ato/gpt-6.1-sol",
      "ato/claude-sonnet",
    ]);
    expect(out.data.find((m) => m.id === "ato/gpt-6.1-sol")?.owned_by).toBe("microsoft/ato");
  });

  it("does not duplicate an already-namespaced id", () => {
    const out = withProfileModels(payload, ["ato"]);
    expect(new Set(out.data.map((m) => m.id)).size).toBe(out.data.length);
  });
});
