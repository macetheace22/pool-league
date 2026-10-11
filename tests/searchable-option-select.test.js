import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = path => readFileSync(resolve(root, path), "utf8");

describe("searchable dropdown consistency", () => {
  it("provides filtering, keyboard selection, escape-to-close, and clear support", () => {
    const picker = read("src/SearchableOptionSelect.jsx");
    expect(picker).toContain("option.label");
    expect(picker).toContain('event.key === "ArrowDown"');
    expect(picker).toContain('event.key === "ArrowUp"');
    expect(picker).toContain('event.key === "Enter"');
    expect(picker).toContain('event.key === "Escape"');
    expect(picker).toContain("choose(null)");
    expect(picker).toContain('role="listbox"');
    expect(picker).toContain('role="option"');
  });

  it("uses searchable pickers for long player, team, captain, venue, division, and week choices", () => {
    const admin = read("src/AdminApp.jsx");
    expect(admin).toContain('ariaLabel="Search forfeiting player"');
    expect(admin).toContain('ariaLabel="Search receiving player"');
    expect(admin).toContain('ariaLabel="Search teams for invite code"');
    expect(admin).toContain('ariaLabel="Search captain accounts"');
    expect(admin).toContain('ariaLabel="Search team venues"');
    expect(admin).toContain('ariaLabel="Filter by division or season"');
    expect(admin).toContain('ariaLabel="Search scheduled weeks"');
    expect(admin).toContain('ariaLabel="Search destination teams"');
    expect(admin).toContain('ariaLabel="Search existing teams to map"');
  });
});
