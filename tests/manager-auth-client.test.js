import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("manager impersonation backup auth client", () => {
  it("persists the backup without independently refreshing its rotating refresh token", () => {
    const source = readFileSync(resolve(root, "src/supabaseClient.js"), "utf8");
    const backupClient = source.split("export const managerAuthClient = createClient")[1];

    expect(backupClient).toContain("storageKey: 'iba-manager-impersonation-auth'");
    expect(backupClient).toContain("persistSession: true");
    expect(backupClient).toContain("autoRefreshToken: false");
    expect(backupClient).toContain("detectSessionInUrl: false");
  });
});
