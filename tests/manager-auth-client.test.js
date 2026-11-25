import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

describe("manager impersonation session backup", () => {
  it("stores the manager session as an inert backup without a second Supabase auth client", () => {
    const auth = read("src/AuthContext.jsx");
    const client = read("src/supabaseClient.js");

    expect(auth).toContain('const managerSessionStorageKey = "iba-manager-impersonation-session"');
    expect(auth).toContain("localStorage.setItem(managerSessionStorageKey, JSON.stringify(sessionData.session))");
    expect(auth).toContain("readManagerSessionBackup()");
    expect(auth).toContain("supabase.auth.setSession({");
    expect(auth).not.toContain("managerAuthClient");
    expect(client).not.toContain("managerAuthClient");
  });

  it("verifies the restored manager identity before clearing the backup", () => {
    const auth = read("src/AuthContext.jsx");
    expect(auth).toContain("restoredData.session?.user?.id !== backupSession.user.id");
    expect(auth).toContain("await clearManagerBackup();");
    expect(auth.indexOf("restoredData.session?.user?.id !== backupSession.user.id"))
      .toBeLessThan(auth.indexOf("await clearManagerBackup();"));
  });
});
