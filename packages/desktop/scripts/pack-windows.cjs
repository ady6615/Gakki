/**
 * Portable Windows Desktop Packaging Script
 *
 * Implements Requirement 30:
 * Creates a standalone, self-contained development / portable Windows distribution
 * containing Gakki.exe, runtime dependencies, and web bundle.
 */

const fs = require('fs');
const path = require('path');

async function packWindows() {
  console.log('================================================================');
  console.log('       GAKKI MUSIC PLATFORM — WINDOWS DESKTOP PACKAGING        ');
  console.log('================================================================\n');

  const rootDir = path.resolve(__dirname, '..');
  const electronDistDir = path.resolve(rootDir, '../../node_modules/electron/dist');
  const outDir = path.resolve(rootDir, 'release/Gakki-win32-x64');

  if (!fs.existsSync(electronDistDir)) {
    throw new Error(`Electron dist not found at: ${electronDistDir}`);
  }

  console.log(`[PACK] Creating portable distribution at: ${outDir}`);
  fs.mkdirSync(outDir, { recursive: true });

  const targetExe = path.join(outDir, 'Gakki.exe');
  if (!fs.existsSync(targetExe)) {
    console.log('[PACK] Copying Electron runtime binaries...');
    fs.cpSync(electronDistDir, outDir, { recursive: true });

    const srcExe = path.join(outDir, 'electron.exe');
    if (fs.existsSync(srcExe)) {
      fs.renameSync(srcExe, targetExe);
      console.log('[PACK] Renamed executable -> Gakki.exe');
    }
  } else {
    console.log('[PACK] Runtime binary Gakki.exe is already present.');
  }

  // 3. Create resources/app
  const appDir = path.join(outDir, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });

  // Copy desktop package.json & dist
  console.log('[PACK] Bundling desktop application files...');
  fs.copyFileSync(path.join(rootDir, 'package.json'), path.join(appDir, 'package.json'));
  fs.cpSync(path.join(rootDir, 'dist'), path.join(appDir, 'dist'), { recursive: true });

  // Copy web dist bundle if built
  const webDist = path.resolve(rootDir, '../web/dist');
  if (fs.existsSync(webDist)) {
    console.log('[PACK] Bundling web client distribution...');
    fs.cpSync(webDist, path.join(appDir, 'web/dist'), { recursive: true });
  }

  // 4. Create README for user
  const readmeContent = [
    '# Gakki Desktop Application (Windows Portable Release)',
    '',
    '## Quick Start',
    'Double-click `Gakki.exe` to launch the application.',
    '',
    '## System Audio Routing',
    '- Go to Settings -> Audio Routing in the Gakki UI.',
    '- Select Output Device (Headphones, Speakers, or VB-Audio Cable).',
    '- For Discord/Meet output without bot: Select "Virtual Output" and set Discord input to VB-Audio Cable.',
    '',
    '## Log Files',
    'User logs are available at: `%APPDATA%\\Gakki\\logs\\desktop.log`',
  ].join('\r\n');

  fs.writeFileSync(path.join(outDir, 'README.txt'), readmeContent, 'utf-8');

  console.log('\n[PACK] Successfully created portable Windows build:');
  console.log(`       -> ${targetExe}`);
}

packWindows().catch((err) => {
  console.error('[PACK] Error packaging Windows desktop application:', err);
  process.exit(1);
});
