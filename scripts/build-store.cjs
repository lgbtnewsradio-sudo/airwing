const { build, Platform, Arch } = require('electron-builder');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { existsSync, readdirSync, copyFileSync, cpSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { getWindowsKitsBundle } = require('app-builder-lib/out/toolsets/windows');
const root = join(__dirname, '..');
const fields = ['AIRWING_STORE_IDENTITY', 'AIRWING_STORE_PUBLISHER', 'AIRWING_STORE_PUBLISHER_NAME'];
const missing = fields.filter((key) => !process.env[key]?.trim());
if (missing.length) {
  console.error(`Store identity is required. Copy these values from Partner Center: ${missing.join(', ')}. See docs/STORE.md.`);
  process.exit(1);
}
const [identityName, publisher, publisherDisplayName] = fields.map((key) => process.env[key].trim());
if (!/^[A-Za-z0-9.-]{3,50}$/.test(identityName) || !publisher.startsWith('CN=') || /[<>&'"\r\n]/.test(publisher + publisherDisplayName)) {
  console.error('Invalid package identity or publisher. Copy the exact Partner Center values; XML-unsafe publisher names require manifest escaping before packaging.');
  process.exit(1);
}
for (const file of ['LICENSE', 'NOTICE', 'docs/PRIVACY.md']) {
  if (!existsSync(join(root, file))) throw new Error(`Missing distribution document: ${file}`);
}
const config = {
  extends: join(root, 'electron-builder.yml'),
  directories: { output: 'release/store' },
  toolsets: { winCodeSign: '1.1.0' },
  win: { target: [{ target: 'appx', arch: ['x64'] }], artifactName: '${productName}-${version}-store-${arch}.${ext}' },
  appx: { identityName, publisher, publisherDisplayName, applicationId: 'AirWing',
    displayName: 'AirWing', languages: ['en-US'], minVersion: '10.0.19041.0',
    capabilities: ['runFullTrust', 'privateNetworkClientServer', 'internetClient'],
    addAutoLaunchExtension: false, setBuildNumber: false },
  publish: null,
};
if (process.argv.includes('--check')) {
  console.log('Store identity and distribution documents validated. APPX target configured. Certification and packaged-runtime testing are still required.');
} else {
  const node = process.execPath;
  const electronEnv = { ...process.env }; delete electronEnv.ELECTRON_RUN_AS_NODE;
  execFileSync(require('electron'), [join(root, 'scripts/store-assets.cjs')], { cwd: root, stdio: 'inherit', windowsHide: true, env: electronEnv });
  execFileSync(node, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'], { cwd: root, stdio: 'inherit' });
  getWindowsKitsBundle({ winCodeSign: config.toolsets.winCodeSign, arch: Arch.x64 }).then(({ kit, appxAssets }) => {
    const localKit = mkdtempSync(join(tmpdir(), 'airwing-kit-'));
    cpSync(kit, localKit, { recursive: true });
    cpSync(join(appxAssets, 'appxAssets'), join(localKit, 'appxAssets'), { recursive: true });
    for (const name of readdirSync(localKit).filter((name) => name.endsWith('.dll.manifest'))) {
      const assemblyManifest = join(localKit, name.replace(/\.dll\.manifest$/, '.manifest'));
      if (!existsSync(assemblyManifest)) copyFileSync(join(localKit, name), assemblyManifest);
    }
    process.env.ELECTRON_BUILDER_WINDOWS_KITS_PATH = localKit;
    return build({ projectDir: root, targets: Platform.WINDOWS.createTarget(['appx'], Arch.x64), config });
  }).catch((error) => {
    console.error(error.message); process.exitCode = 1;
  });
}
