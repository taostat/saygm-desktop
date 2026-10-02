import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repoRoot, 'ui/desktop/package.json'));
const asar = require('@electron/asar');
const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  assert(process.argv[index].startsWith('--') && process.argv[index + 1], 'Use named option/value pairs');
  args[process.argv[index].slice(2)] = process.argv[index + 1];
}
for (const name of ['deb', 'zip', 'source-backend', 'report']) assert(args[name], `Missing --${name}`);

const sha256 = async (filename) => createHash('sha256').update(await fs.readFile(filename)).digest('hex');
const output = (command) => execFileSync(command[0], command.slice(1), { encoding: 'utf8' }).trim();
const packageName = output(['dpkg-deb', '--field', args.deb, 'Package']);
const version = output(['dpkg-deb', '--field', args.deb, 'Version']);
const architecture = output(['dpkg-deb', '--field', args.deb, 'Architecture']);
assert.equal(packageName, 'saygm');
assert.equal(version, '0.1.0~rc.5');
assert.equal(architecture, 'amd64');

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'saygm-deb-verify-'));
try {
  const packageRoot = path.join(temporary, 'deb');
  const zipRoot = path.join(temporary, 'zip');
  await fs.mkdir(packageRoot);
  await fs.mkdir(zipRoot);
  execFileSync('dpkg-deb', ['-x', args.deb, packageRoot]);
  execFileSync('unzip', ['-q', args.zip, '-d', zipRoot]);

  const walk = async (root) => {
    const results = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const filename = path.join(root, entry.name);
      if (entry.isDirectory()) results.push(...await walk(filename));
      else results.push(filename);
    }
    return results;
  };
  const debFiles = await walk(packageRoot);
  const debDesktop = debFiles.find((filename) => filename.endsWith('.desktop'));
  assert(debDesktop, 'Debian package must include a desktop entry');
  const desktopText = await fs.readFile(debDesktop, 'utf8');
  assert.match(desktopText, /^Exec=\/usr\/bin\/saygm %U$/m);
  assert.match(desktopText, /^Icon=saygm$/m);
  assert(debFiles.some((filename) => /\/saygm\.(png|svg|xpm)$/i.test(filename)), 'Debian package must include the SayGM application icon');

  const launcher = path.join(packageRoot, 'usr/bin/saygm');
  const launcherLink = await fs.readlink(launcher);
  const resolvedLauncher = launcherLink.startsWith('/')
    ? path.join(packageRoot, launcherLink.slice(1))
    : path.resolve(path.dirname(launcher), launcherLink);
  assert.equal(resolvedLauncher, path.join(packageRoot, 'usr/lib/saygm/SayGM'));
  const debApp = path.join(packageRoot, 'usr/lib/saygm/SayGM');
  const debBackend = path.join(packageRoot, 'usr/lib/saygm/resources/bin/goose');
  assert((await fs.stat(debApp)).isFile());
  assert((await fs.stat(debBackend)).isFile());

  const zipFiles = await walk(zipRoot);
  const debAsar = debFiles.find((filename) => filename.endsWith('/resources/app.asar'));
  const zipAsar = zipFiles.find((filename) => filename.endsWith('/resources/app.asar'));
  const zipBackend = zipFiles.find((filename) => filename.endsWith('/resources/bin/goose'));
  let zipApp;
  for (const filename of zipFiles) {
    if (!/\/SayGM$/.test(filename)) continue;
    try {
      if ((await fs.stat(filename)).isFile()) { zipApp = filename; break; }
    } catch { /* Not an app executable. */ }
  }
  assert(debAsar && zipAsar && zipBackend && zipApp, 'Debian and ZIP packages must include app ASAR and Goose backend');

  const sensitivePath = /(^|\/)(\.env(?:\.[^/]*)?|credentials?|private[-_]?profile|test[-_]?fixture[-_]?keys?)(\/|$)/i;
  const asarPaths = { deb: asar.listPackage(debAsar), zip: asar.listPackage(zipAsar) };
  for (const [packageType, paths] of Object.entries(asarPaths)) {
    for (const archivePath of paths) {
      assert(!sensitivePath.test(archivePath.replace(/^\/+/, '')), `Sensitive file path bundled in ${packageType} ASAR: ${archivePath}`);
    }
  }
  const expectedBackendHash = await sha256(args['source-backend']);
  assert.equal(await sha256(debBackend), expectedBackendHash, 'Debian package backend must match Cargo output');
  assert.equal(await sha256(zipBackend), expectedBackendHash, 'Portable package backend must match Cargo output');
  const machine = output(['readelf', '-h', debBackend]);
  assert.match(machine, /Machine:\s+Advanced Micro Devices X86-64/);
  const ldd = output(['ldd', debBackend]);
  assert(!ldd.includes('not found'), 'Bundled backend has a missing shared library');
  const dependencies = output(['dpkg-deb', '--field', args.deb, 'Depends']);
  const dependencyNames = new Set(dependencies.split(',').map((item) => item.trim().match(/^([a-z0-9][a-z0-9+.-]*)/)?.[1]).filter(Boolean));
  assert(dependencyNames.has('libsecret-1-0'), 'Debian package must declare Secret Service runtime support');
  for (const line of ldd.split(String.fromCharCode(10))) {
    const library = line.match(/=>\s+(\/\S+)/)?.[1] ?? line.match(/^\s*(\/\S+)/)?.[1];
    if (!library) continue;
    const owner = output(['dpkg-query', '-S', library]).split(String.fromCharCode(10))[0].split(':')[0];
    assert(dependencyNames.has(owner), `Debian Depends omits Goose runtime package ${owner} (${library})`);
  }

  const report = {
    result: 'passed',
    package: packageName,
    debian_version: version,
    desktop_version: '0.1.0-rc.5',
    architecture,
    deb_sha256: await sha256(args.deb),
    zip_sha256: await sha256(args.zip),
    goose_sha256: expectedBackendHash,
    package_desktop_entry: path.relative(packageRoot, debDesktop),
    package_exec: '/usr/bin/saygm',
    package_icon: 'saygm',
    backend_ldd: ldd.split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean),
    asar_path_count: { deb: asarPaths.deb.length, zip: asarPaths.zip.length },
    sensitive_path_scan: 'passed',
  };
  const reportPath = path.resolve(args.report);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}${String.fromCharCode(10)}`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
