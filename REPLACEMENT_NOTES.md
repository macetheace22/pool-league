# Pool League App — IBA Schedule Import Update

This package contains the current project with the IBA schedule import changes applied.

## What changed

- Uses IBA's real `/League/GetDivisions` endpoint for format/day discovery.
- Uses IBA's real `/League/GetSchedule?id=m8-pool-league&divId=...` endpoint for each division.
- Automatically discovers every published division and selects all of them for import.
- Uses the portion after `!` in IBA division values such as `287!8538257` as the local division number.
- Added `db.importIbaScheduleDivision()` to upsert divisions, teams, schedules, and playoff metadata into Supabase.
- Re-importing a division replaces its schedule weeks/pairings rather than duplicating them.
- Preserves existing team UUIDs and app-owned team data on re-import.
- Handles nested IBA pairing tables, TBD opponents, holidays, and playoff rows.
- Added parser tests in `tests/ibaScheduleApi.test.js`.

## Deployment

1. Extract this package over your existing project directory.
2. Keep your existing `.env` / `.env.local` files; they are intentionally not included in this package.
3. Run `npm ci`.
4. Run `npm test`.
5. Run `npm run build`.
6. Commit and push the project to GitHub so Vercel deploys it.

## Important

The package intentionally excludes `.env`, `.env.local`, `.git`, `.vercel`, `node_modules`, and `dist`.

### Follow-up build fix
- Added `listActiveTeamsByNumbers()` to `src/db.js`, which `src/ibaAutoSync.js` requires to route IBA standings/MVP report team numbers to active-season teams without guessing when a number is ambiguous.
