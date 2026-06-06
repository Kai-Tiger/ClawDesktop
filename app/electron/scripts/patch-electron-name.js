const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

if (process.platform !== 'darwin') process.exit(0);

const dist = path.join(__dirname, '../node_modules/electron/dist');
const oldApp = path.join(dist, 'Electron.app');
const newApp = path.join(dist, 'ClawDesktop.app');
const plist = path.join(newApp, 'Contents/Info.plist');
const pathTxt = path.join(__dirname, '../node_modules/electron/path.txt');

// Rename .app bundle if needed
if (fs.existsSync(oldApp) && !fs.existsSync(newApp)) {
  fs.renameSync(oldApp, newApp);
  console.log('Renamed Electron.app → ClawDesktop.app');
}

// Patch Info.plist
if (fs.existsSync(plist)) {
  execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleName ClawDesktop" "${plist}"`);
  execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName ClawDesktop" "${plist}"`);
  console.log('Patched Info.plist');
}

// Update path.txt
if (fs.existsSync(pathTxt)) {
  const current = fs.readFileSync(pathTxt, 'utf8').trim();
  if (current.startsWith('Electron.app')) {
    fs.writeFileSync(pathTxt, current.replace('Electron.app', 'ClawDesktop.app'));
    console.log('Updated path.txt');
  }
}

// Re-register with Launch Services
if (fs.existsSync(newApp)) {
  try {
    execSync(`/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "${newApp}"`);
    execSync('killall Dock');
    console.log('Re-registered with Launch Services');
  } catch {}
}
