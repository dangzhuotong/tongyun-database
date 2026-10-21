import { describe, expect, it } from "vitest";
import manifestRaw from "../src-tauri/Cargo.toml?raw";
import shellRaw from "../src-tauri/src/lib.rs?raw";
import coreRaw from "../../crates/tongyun-database-core/Cargo.toml?raw";
import { settingsSavePayload } from "./settings";

describe("settings save", () => {
  it("sends only the theme", () => {
    expect(settingsSavePayload("dark")).toEqual({ theme: "dark" });
    expect(Object.keys(settingsSavePayload("light"))).toEqual(["theme"]);
    expect(() => settingsSavePayload("password")).toThrow("主题无效");
  });
});

describe("desktop shell does not link the OS keychain", () => {
  it("keeps keyring and stronghold out of the desktop manifest and shell", () => {
    const manifest = manifestRaw.toLowerCase();
    const shell = shellRaw.toLowerCase();
    const core = coreRaw.toLowerCase();
    for (const text of [manifest, shell, core]) {
      expect(text).not.toContain("keyring");
      expect(text).not.toContain("stronghold");
      expect(text).not.toContain("secitem");
    }
  });
});
