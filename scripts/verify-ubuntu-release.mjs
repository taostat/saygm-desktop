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
for (const name of ['deb', 'zip', 'source-backend', 'arch', 'report']) assert(args[name], `Missing --${name}`);
const expectedVersion = args['expected-version'] ?? process.env.SAYGM_BETA_VERSION ?? '0.1.0-rc.5';
const expectedDebianVersion = expectedVersion.replace('-', '~');

const architectures = {
  x64: { debian: 'amd64', machine: /Machine:\s+Advanced Micro Devices X86-64/ },
  arm64: { debian: 'arm64', machine: /Machine:\s+AArch64/ },
};
const expectedArchitecture = architectures[args.arch];
assert(expectedArchitecture, `Unsupported Ubuntu architecture ${args.arch}`);

const sha256 = async (filename) => createHash('sha256').update(await fs.readFile(filename)).digest('hex');
const output = (command) => execFileSync(command[0], command.slice(1), { encoding: 'utf8' }).trim();
const packageName = output(['dpkg-deb', '--field', args.deb, 'Package']);
const version = output(['dpkg-deb', '--field', args.deb, 'Version']);
const architecture = output(['dpkg-deb', '--field', args.deb, 'Architecture']);
assert.equal(packageName, 'saygm');
assert.equal(version, expectedDebianVersion);
assert.equal(architecture, expectedArchitecture.debian);

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'saygm-deb-verify-'));
try {
  const packageRoot = path.join(temporary, 'deb');
  const zipRoot = path.join(temporary, 'zip');
  await fs.mkdir(packageRoot);
  await fs.mkdir(zipRoot);
  execFileSync('dpkg-deb', ['-x', args.deb, packageRoot]);

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

  const debAsar = debFiles.find((filename) => filename.endsWith('/resources/app.asar'));
  const zipEntries = output(['unzip', '-Z1', args.zip]).split(String.fromCharCode(10)).filter(Boolean);
  const zipAppEntry = zipEntries.find((filename) => /\/SayGM$/.test(filename));
  const zipAsarEntry = zipEntries.find((filename) => filename.endsWith('/resources/app.asar'));
  const zipBackendEntry = zipEntries.find((filename) => filename.endsWith('/resources/bin/goose'));
  assert(debAsar && zipAppEntry && zipAsarEntry && zipBackendEntry, 'Debian and ZIP packages must include app ASAR and Goose backend');
  execFileSync('unzip', ['-tqq', args.zip]);
  execFileSync('unzip', ['-q', args.zip, zipAppEntry, zipAsarEntry, zipBackendEntry, '-d', zipRoot]);
  const zipApp = path.join(zipRoot, zipAppEntry);
  const zipAsar = path.join(zipRoot, zipAsarEntry);
  const zipBackend = path.join(zipRoot, zipBackendEntry);
  for (const filename of [zipApp, zipAsar, zipBackend]) assert((await fs.stat(filename)).isFile());
  const debAppPackage = JSON.parse(asar.extractFile(debAsar, 'package.json').toString());
  const zipAppPackage = JSON.parse(asar.extractFile(zipAsar, 'package.json').toString());
  assert.equal(debAppPackage.version, expectedVersion, 'Debian ASAR package.json must have the expected beta version');
  assert.equal(zipAppPackage.version, expectedVersion, 'ZIP ASAR package.json must have the expected beta version');

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
  const debAppHash = await sha256(debApp);
  const zipAppHash = await sha256(zipApp);
  const debAsarHash = await sha256(debAsar);
  const zipAsarHash = await sha256(zipAsar);
  assert.equal(debAppHash, zipAppHash, 'Debian and ZIP app executables must be identical');
  assert.equal(debAsarHash, zipAsarHash, 'Debian and ZIP ASARs must be identical');
  for (const executable of [debApp, debBackend, zipApp, zipBackend]) {
    assert.match(output(['readelf', '-h', executable]), expectedArchitecture.machine, `${executable} has the wrong ELF architecture`);
  }
  const ldd = output(['ldd', debBackend]);
  assert(!ldd.includes('not found'), 'Bundled backend has a missing shared library');
  const dependencies = output(['dpkg-deb', '--field', args.deb, 'Depends']);
  const dependencyNames = new Set(dependencies.split(',').map((item) => item.trim().match(/^([a-z0-9][a-z0-9+.-]*)/)?.[1]).filter(Boolean));
  assert(dependencyNames.has('libsecret-1-0'), 'Debian package must declare Secret Service runtime support');
  assert(dependencyNames.has('libasound2'), 'Debian package must declare Electron audio runtime support');
  const packageOwner = async (library) => {
    let resolved;
    try { resolved = await fs.realpath(library); } catch { /* Try the original path below. */ }
    for (const candidate of new Set([library, resolved].filter(Boolean))) {
      try {
        const owner = output(['dpkg-query', '-S', candidate]).split(String.fromCharCode(10))[0].split(':')[0];
        if (owner) return owner;
      } catch { /* Try the canonical path if the linker path is an unowned alias. */ }
    }
    return undefined;
  };
  for (const line of ldd.split(String.fromCharCode(10))) {
    const library = line.match(/=>\s+(\/\S+)/)?.[1] ?? line.match(/^\s*(\/\S+)/)?.[1];
    if (!library) continue;
    const owner = await packageOwner(library);
    assert(owner, `No Ubuntu package owns Goose runtime library ${library}`);
    assert(dependencyNames.has(owner), `Debian Depends omits Goose runtime package ${owner} (${library})`);
  }

  const report = {
    result: 'passed',
    package: packageName,
    debian_version: version,
    desktop_version: expectedVersion,
    product_source_revision: process.env.SAYGM_PRODUCT_SOURCE_SHA ?? null,
    build_automation_revision: process.env.GITHUB_SHA ?? null,
    build_arch: args.arch,
    architecture,
    deb_sha256: await sha256(args.deb),
    zip_sha256: await sha256(args.zip),
    app_sha256: debAppHash,
    asar_sha256: debAsarHash,
    goose_sha256: expectedBackendHash,
    asar_package_version: debAppPackage.version,
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
