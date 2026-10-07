const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, rm, stat, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { renamePackagedBackend } = require('./rename-packaged-backend.cjs');

const fixtures = [];

async function makeFixture(filename) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'saygm-packaged-backend-'));
  fixtures.push(root);
  const resources = path.join(root, 'resources');
  const bin = path.join(resources, 'bin');
  await mkdir(bin, { recursive: true });
  const source = path.join(bin, filename);
  await writeFile(source, Buffer.from('fixture backend bytes'));
  await require('node:fs/promises').chmod(source, 0o755);
  return { bin, source, resources };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

for (const [platform, filename, expected] of [
  ['darwin', 'goose', 'saygm-agent'],
  ['linux', 'goose', 'saygm-agent'],
  ['win32', 'goose.exe', 'saygm-agent.exe'],
]) {
  test(`renames ${platform} packaged backend and preserves bytes and executable mode`, async () => {
    const fixture = await makeFixture(filename);
    const sourceMode = (await stat(fixture.source)).mode & 0o777;

    const destination = await renamePackagedBackend(fixture.resources, platform);

    assert.equal(destination, path.join(fixture.bin, expected));
    assert.deepEqual(await readFile(destination), Buffer.from('fixture backend bytes'));
    assert.equal((await stat(destination)).mode & 0o777, sourceMode);
    await assert.rejects(stat(fixture.source), { code: 'ENOENT' });
  });
}

test('fails closed if the packaged destination already exists', async () => {
  const fixture = await makeFixture('goose');
  const destination = path.join(fixture.bin, 'saygm-agent');
  await writeFile(destination, 'preexisting fixture');

  await assert.rejects(renamePackagedBackend(fixture.resources, 'darwin'), /destination already exists/);
  assert.equal((await readFile(fixture.source)).toString(), 'fixture backend bytes');
  assert.equal((await readFile(destination)).toString(), 'preexisting fixture');
});

test('fails if the platform packaged backend source is missing', async () => {
  const fixture = await makeFixture('goose');
  await rm(fixture.source);

  await assert.rejects(renamePackagedBackend(fixture.resources, 'win32'), /source is missing/);
});
