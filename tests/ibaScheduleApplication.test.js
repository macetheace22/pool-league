import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

describe("IBA approved schedule application contracts", () => {
  it("creates an auditable application history and guarded manager RPC", () => {
    const sql = read("supabase-schema-section-91-iba-schedule-application.sql");

    expect(sql).toContain("create table if not exists public.iba_schedule_change_applications");
    expect(sql).toContain("before_snapshot jsonb not null");
    expect(sql).toContain("after_snapshot jsonb not null");
    expect(sql).toContain("unique (monitor_check_id)");
    expect(sql).toContain("public.current_role_name() <> 'manager'");
    expect(sql).toContain("check_row.review_status <> 'approved'");
    expect(sql).toContain("review_status = 'applied'");
    expect(sql).toContain("application_id = application_row.id");
    expect(sql).toContain("revoke all on function public.apply_iba_schedule_change(uuid) from public, anon");
    expect(sql).toContain("grant execute on function public.apply_iba_schedule_change(uuid) to authenticated");
    expect(sql).toContain("A newer IBA schedule check exists for this division");
    expect(sql).toContain("delete from public.schedule_weeks");
  });

  it("exposes only the manager application action in the review UI", () => {
    const review = read("src/IbaScheduleReview.jsx");

    expect(review).toContain('.in("review_status", ["pending", "approved"])');
    expect(review).toContain('supabase.rpc("apply_iba_schedule_change"');
    expect(review).toContain("Apply to Schedule");
    expect(review).toContain("Approval alone does not modify the league schedule.");
    expect(review).toContain('review_status: decision');
  });
});
