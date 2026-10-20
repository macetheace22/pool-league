# Supabase Data API access for new tables

Supabase's Data API change effective October 30, 2026 means new tables in the exposed `public` schema must receive explicit table privileges before PostgREST / `supabase-js` can use them. Existing tables retain their current grants.

## Required for each new public table

In the same SQL section/migration that creates a table:

1. Enable row-level security (RLS).
2. Revoke default `PUBLIC` and `anon` table privileges unless anonymous access is deliberately required.
3. Grant only the operations needed by the intended roles. A grant makes a table reachable; RLS policies still determine which rows a role can read or change.
4. Add policies that match the actual role/ownership rules. Do not use a generic authenticated CRUD policy on every table.

Example for a manager-only table (adapt table name and operations to the feature):

```sql
ALTER TABLE public.example_table ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.example_table FROM PUBLIC, anon;

-- Only if the application needs signed-in managers to read/write this table:
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.example_table TO authenticated;

-- Only if server-side service-role access is needed:
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.example_table TO service_role;

CREATE POLICY "Managers can read example table"
  ON public.example_table
  FOR SELECT TO authenticated
  USING (public.current_role_name() = 'manager');

CREATE POLICY "Managers can insert example table"
  ON public.example_table
  FOR INSERT TO authenticated
  WITH CHECK (public.current_role_name() = 'manager');

CREATE POLICY "Managers can update example table"
  ON public.example_table
  FOR UPDATE TO authenticated
  USING (public.current_role_name() = 'manager')
  WITH CHECK (public.current_role_name() = 'manager');

CREATE POLICY "Managers can delete example table"
  ON public.example_table
  FOR DELETE TO authenticated
  USING (public.current_role_name() = 'manager');
```

This is a pattern, not a copy/paste migration: omit unused operations, add ownership/tenant predicates where appropriate, and only grant `anon` access when a documented anonymous workflow requires it. Never expose the `service_role` key to browser code.

## CI protection

The repository CI checks changed SQL files for new `public` table declarations and requires explicit RLS enablement, a revoke protecting `anon`/`PUBLIC`, and a table-level grant. This is a guardrail, not a complete SQL/RLS policy verifier; review each migration's policies and run Supabase security advisors after schema changes.

The existing project was audited on October 20, 2026. The current public tables have explicit table grants, but some legacy views lack RLS and need a separate view-access review. This change does not alter existing table grants or production data.
