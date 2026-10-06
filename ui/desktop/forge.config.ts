const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const { createHash } = require('node:crypto');
const { readFile, rm, writeFile } = require('node:fs/promises');
const { resolve } = require('path');

const isLinuxVulkanBuild = process.env.GOOSE_DESKTOP_LINUX_VARIANT === 'vulkan';
const betaVersion = process.env.SAYGM_BETA_VERSION;

function removeBuildOnlyBinFiles(
  buildPath,
  _electronVersion,
  platform,
  _arch,
  callback
) {
  const resourcesPath =
    platform === 'darwin'
      ? resolve(buildPath, 'SayGM.app', 'Contents', 'Resources')
      : resolve(buildPath, 'resources');

  Promise.all(
    ['.gitkeep', 'node-launchers.test.ts'].map((name) =>
      rm(resolve(resourcesPath, 'bin', name), { force: true })
    )
  ).then(async () => {
    try {
      const expectedBackendSha256 = process.env.SAYGM_MACOS_SOURCE_BACKEND_SHA256;
      if (platform === 'darwin' && betaVersion && !expectedBackendSha256) {
        throw new Error('Signed macOS beta packaging requires a recorded native backend hash.');
      }
      if (platform === 'darwin' && expectedBackendSha256) {
        const packagedBackend = await readFile(resolve(resourcesPath, 'bin', 'goose'));
        const actualBackendSha256 = createHash('sha256').update(packagedBackend).digest('hex');
        if (actualBackendSha256 !== expectedBackendSha256) {
          throw new Error('Packaged macOS backend does not match the native build output.');
        }
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }, callback);
}

function setPackagedBetaVersion(buildPath, _electronVersion, platform, _arch, callback) {
  if (platform !== 'darwin' || !betaVersion) {
    callback();
    return;
  }

  const packagePath = resolve(buildPath, 'package.json');
  readFile(packagePath, 'utf8')
    .then((contents) => {
      const packageJson = JSON.parse(contents);
      packageJson.version = betaVersion;
      return writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    })
    .then(() => callback())
    .catch(callback);
}

let cfg = {
  asar: true,
  name: 'SayGM',
  appBundleId: 'com.saygm.desktop',
  afterCopy: [setPackagedBetaVersion],
  afterCopyExtraResources: [removeBuildOnlyBinFiles],
  extraResource: ['src/bin', 'src/images', 'src/fonts/licenses', '../../LICENSE'],
  icon: 'src/images/icon',
  // The Vite build bundles runtime dependencies into .vite; avoid traversing workspace links.
  prune: false,
  // Windows specific configuration
  win32: {
    icon: 'src/images/icon.ico',
    certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
    signingRole: process.env.WINDOW_SIGNING_ROLE,
    rfc3161TimeStampServer: 'http://timestamp.digicert.com',
    signWithParams: '/fd sha256 /tr http://timestamp.digicert.com /td sha256',
  },
  // Protocol registration
  protocols: [
    {
      name: 'SayGMProtocol',
      schemes: ['saygm'],
    },
  ],
  // macOS Info.plist extensions for drag-and-drop support
  extendInfo: {
    // Document types for drag-and-drop support onto dock icon
    CFBundleDocumentTypes: [
      {
        CFBundleTypeName: 'Folders',
        CFBundleTypeRole: 'Viewer',
        LSHandlerRank: 'Alternate',
        LSItemContentTypes: ['public.directory', 'public.folder'],
      },
    ],
    // Usage descriptions for macOS TCC (Transparency, Consent, and Control)
    NSMicrophoneUsageDescription:
      'SayGM Desktop needs access to your microphone for voice dictation.',
    NSAppleEventsUsageDescription:
      'SayGM Desktop needs access to send Apple Events to control other apps on your behalf.',
  },
};

if (betaVersion) {
  cfg.appVersion = betaVersion;
}

// macOS code signing and notarization via Electron Forge
// Activated when APPLE_TEAM_ID is set (CI signing builds)
if (process.env.APPLE_TEAM_ID) {
  const signingIdentity = process.env.APPLE_SIGNING_IDENTITY;
  const keychain = process.env.KEYCHAIN_PATH;
  if (!signingIdentity || !keychain) {
    throw new Error('macOS signing requires an explicit identity and temporary keychain.');
  }

  cfg.osxSign = {
    keychain,
    identity: signingIdentity,
    continueOnError: false,
    optionsForFile: (filePath) => ({
      entitlements:
        filePath.endsWith('.app') && !filePath.includes('.app/')
          ? resolve(__dirname, 'entitlements.plist')
          : resolve(__dirname, 'entitlements.inherit.plist'),
      hardenedRuntime: true,
    }),
  };

  if (process.env.SAYGM_NOTARIZATION_METHOD === 'app-store-connect') {
    if (
      !process.env.APPLE_API_KEY_PATH ||
      !process.env.APPLE_API_KEY_ID ||
      !process.env.APPLE_API_ISSUER_ID
    ) {
      throw new Error('App Store Connect notarization requires a key file, key ID, and issuer ID.');
    }
    cfg.osxNotarize = {
      appleApiKey: process.env.APPLE_API_KEY_PATH,
      appleApiKeyId: process.env.APPLE_API_KEY_ID,
      appleApiIssuer: process.env.APPLE_API_ISSUER_ID,
    };
  } else if (process.env.SAYGM_NOTARIZATION_METHOD === 'apple-id') {
    if (!process.env.APPLE_ID || !process.env.APPLE_ID_PASSWORD) {
      throw new Error('Apple ID notarization requires an Apple ID and app-specific password.');
    }
    cfg.osxNotarize = {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_ID_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    };
  } else {
    throw new Error('A supported macOS notarization method must be configured.');
  }
}

module.exports = {
  packagerConfig: cfg,
  outDir: process.env.SAYGM_RELEASE_OUT_DIR || 'out',
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32', 'linux'],
      config: {
        arch: process.env.ELECTRON_ARCH === 'x64' ? ['x64'] : ['arm64'],
        options: {
          icon: 'src/images/icon.ico',
        },
      },
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        name: 'SayGM',
        bin: 'SayGM',
        maintainer: 'SayGM',
        homepage: 'https://saygm.com/',
        categories: ['Development'],
        desktopTemplate: './forge.deb.desktop',
        options: {
          icon: 'src/images/icon.png',
          prefix: '/opt',
          ...(isLinuxVulkanBuild ? { depends: ['libvulkan1'] } : {}),
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        name: 'SayGM',
        bin: 'SayGM',
        maintainer: 'SayGM',
        homepage: 'https://saygm.com/',
        categories: ['Development'],
        desktopTemplate: './forge.rpm.desktop',
        options: {
          icon: 'src/images/icon.png',
          prefix: '/opt',
          ...(isLinuxVulkanBuild ? { requires: ['vulkan-loader'] } : {}),
        },
      },
    },
    {
      name: '@electron-forge/maker-flatpak',
      config: {
        options: {
          id: 'com.saygm.desktop',
          categories: ['Development'],
          mimeType: ['x-scheme-handler/saygm'],
          icon: {
            scalable: 'src/images/icon.svg',
            '512x512': 'src/images/icon-512.png',
          },
          homepage: 'https://saygm.com/',
          runtimeVersion: '25.08',
          baseVersion: '25.08',
          bin: 'SayGM',
          modules: [
            {
              name: 'libbz2-shim',
              buildsystem: 'simple',
              'build-commands': [
                // Create the lib directory in the app bundle
                'mkdir -p /app/lib',
                // Point to the actual library in the 25.08 runtime
                // We use a wildcard to handle multi-arch paths (x86_64-linux-gnu, etc)
                'ln -s $(find /usr/lib -name "libbz2.so.1" | head -n 1) /app/lib/libbz2.so.1.0',
              ],
            },
            {
              name: 'git',
              buildsystem: 'simple',
              'build-commands': [
                'mkdir -p /app/bin /app/libexec/git-core',
                'cp /usr/bin/git /app/bin/git',
                'cp /usr/libexec/git-core/git-remote-https /app/libexec/git-core/git-remote-https 2>/dev/null || true',
              ],
            },
          ],
          finishArgs: [
            '--share=ipc',
            '--socket=x11',
            '--socket=wayland',
            '--device=dri',
            '--share=network',
            '--filesystem=home',
            '--talk-name=org.freedesktop.Notifications',
            '--socket=session-bus',
            '--socket=system-bus',
            // This ensures the app looks in our shim folder first
            '--env=LD_LIBRARY_PATH=/app/lib',
            '--env=GIT_EXEC_PATH=/app/libexec/git-core',
          ],
        },
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          {
            entry: 'src/main.ts',
            config: 'vite.main.config.mts',
          },
          {
            entry: 'src/preload.ts',
            config: 'vite.preload.config.mts',
          },
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mts',
          },
        ],
      },
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
