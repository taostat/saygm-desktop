const { lstat, rename } = require('node:fs/promises');
const { join } = require('node:path');

async function renamePackagedBackend(resourcesPath, platform) {
  const extension = platform === 'win32' ? '.exe' : '';
  const binPath = join(resourcesPath, 'bin');
  const sourcePath = join(binPath, `goose${extension}`);
  const destinationPath = join(binPath, `saygm-agent${extension}`);

  let sourceStat;
  try {
    sourceStat = await lstat(sourcePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Packaged backend source is missing: ${sourcePath}`);
    }
    throw error;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Packaged backend source is not a regular file: ${sourcePath}`);
  }

  try {
    await lstat(destinationPath);
    throw new Error(`Packaged backend destination already exists: ${destinationPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await rename(sourcePath, destinationPath);
  return destinationPath;
}

module.exports = { renamePackagedBackend };
