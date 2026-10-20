#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const files = process.argv.slice(2).filter((file) => file.endsWith('.sql'));

if (files.length === 0) {
  console.log('No changed SQL files to inspect.');
  process.exit(0);
}

const failures = [];
let tablesChecked = 0;

for (const file of files) {
  const sql = readFileSync(file, 'utf8');
  const createTablePattern =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:(public)\s*\.\s*)?("?([a-zA-Z_][\w$]*)"?)/gi;
  let match;

  while ((match = createTablePattern.exec(sql)) !== null) {
    const schema = (match[1] || 'public').toLowerCase();
    const table = match[3];
    if (schema !== 'public') continue;

    tablesChecked += 1;
    const safeTable = table.replaceAll('$', '\\$');
    const qualifiedTable = 'public\\.\\s*"?'+ safeTable + '"?';
    const rlsPattern = new RegExp(
      'alter\\s+table\\s+(?:if\\s+exists\\s+)?' + qualifiedTable + '\\s+enable\\s+row\\s+level\\s+security\\b',
      'i',
    );
    const revokeAnonPattern = new RegExp(
      'revoke\\s+all\\s+on\\s+' + qualifiedTable + '\\s+from\\s+[^;]*\\b(?:anon|public)\\b',
      'i',
    );
    const explicitGrantPattern = new RegExp(
      'grant\\s+[\\w,\\s]+?\\s+on\\s+' + qualifiedTable + '\\s+to\\s+[^;]+',
      'i',
    );

    if (!rlsPattern.test(sql)) {
      failures.push(file + ': public.' + table + ' is created without ALTER TABLE ... ENABLE ROW LEVEL SECURITY.');
    }
    if (!revokeAnonPattern.test(sql)) {
      failures.push(file + ': public.' + table + ' is created without an explicit REVOKE ALL protecting anon/PUBLIC access.');
    }
    if (!explicitGrantPattern.test(sql)) {
      failures.push(file + ': public.' + table + ' is created without an explicit table-level GRANT for intended API roles.');
    }
  }
}

if (failures.length > 0) {
  console.error('Supabase Data API access checks failed:');
  for (const failure of failures) console.error('- ' + failure);
  console.error(
    '\\nFor each new public table, explicitly enable RLS, revoke default PUBLIC/anon table access, and grant only the operations needed by intended roles in the same SQL migration.',
  );
  process.exit(1);
}

console.log('Supabase Data API access checks passed for ' + tablesChecked + ' public table creation(s) across ' + files.length + ' changed SQL file(s).');
