import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

describe("IBA post-Week-5 TBA to BYE contracts", () => {
  it("creates an auditable manager-only conversion RPC", () => {
    const sql = read("supabase-schema-section-92-iba-tba-to-bye.sql");

    expect(sql).toContain("create table if not exists public.iba_schedule_bye_conversions");
    expect(sql).toContain("converted_side text not null check (converted_side in ('home', 'away'))");
    expect(sql).toContain("previous_tbd_code text not null");
    expect(sql).toContain("unique (pairing_id, converted_side)");
    expect(sql).toContain("public.current_role_name() <> 'manager'");
    expect(sql).toContain("TBA to BYE conversion is available only after the Week 5 date has passed.");
    expect(sql).toContain("A BYE is already the opponent in this pairing.");
    expect(sql).toContain("This week already has a BYE schedule entry.");
    expect(sql).toContain("is_bye = true");
    expect(sql).toContain("home_tbd_code = null");
    expect(sql).toContain("away_tbd_code = null");
    expect(sql).toContain("revoke all on function public.convert_iba_tba_to_bye(uuid, text) from public, anon");
    expect(sql).toContain("grant execute on function public.convert_iba_tba_to_bye(uuid, text) to authenticated");
  });

  it("exposes the post-Week-5 conversion only as a manager action", () => {
    const review = read("src/IbaScheduleReview.jsx");

    expect(review).toContain("Post-Week-5 TBA → BYE");
    expect(review).toContain("Convert to BYE");
    expect(review).toContain('supabase.rpc("convert_iba_tba_to_bye"');
    expect(review).toContain('p_side: row.side');
    expect(review).toContain("Unresolved TBA schedule participants remain untouched through Week 5.");
  });
});
