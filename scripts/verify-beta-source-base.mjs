import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const [sourceRevision] = process.argv.slice(2);
assert.match(sourceRevision ?? '', /^[a-f0-9]{40}$/, 'Pass the exact product source commit SHA');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const automationRevision = git('rev-parse', 'HEAD');
git('cat-file', '-e', `${sourceRevision}^{commit}`);
git('merge-base', '--is-ancestor', sourceRevision, automationRevision);

const allowedBuildAutomationChanges = new Set([
  '.github/workflows/build-ubuntu.yml',
  '.github/workflows/build-windows.yml',
  'scripts/build-ubuntu-release.sh',
  'scripts/qa-native-desktop.mjs',
  'scripts/verify-beta-source-base.mjs',
  'scripts/verify-ubuntu-release.mjs',
  'scripts/windows/saygm-desktop-installer.iss',
  'ui/desktop/forge.config.ts',
]);
const changedPaths = git('diff', '--name-only', `${sourceRevision}...${automationRevision}`)
  .split('\n')
  .filter(Boolean);
const unexpectedPaths = changedPaths.filter((filename) => !allowedBuildAutomationChanges.has(filename));
assert.deepEqual(
  unexpectedPaths,
  [],
  `Product source differs from the approved beta base outside build automation: ${unexpectedPaths.join(', ')}`
);

for (const path of ['Cargo.toml', 'Cargo.lock', 'crates', 'ui/desktop/package.json', 'ui/desktop/src', 'ui/pnpm-lock.yaml']) {
  assert.equal(
    git('rev-parse', `${sourceRevision}:${path}`),
    git('rev-parse', `${automationRevision}:${path}`),
    `Product build input ${path} must match the approved beta source commit`
  );
}

console.log(JSON.stringify({
  result: 'passed',
  product_source_revision: sourceRevision,
  build_automation_revision: automationRevision,
  runtime_tree_unchanged: true,
  allowed_build_automation_changes: changedPaths,
}));
