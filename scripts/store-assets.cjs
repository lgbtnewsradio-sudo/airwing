const { app, nativeImage } = require('electron');
const { mkdirSync, existsSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
app.whenReady().then(() => {
  const icon = nativeImage.createFromPath(join(__dirname, '..', 'build', 'icon.png'));
  if (icon.isEmpty()) throw new Error('The AirWing icon could not be loaded.');
  const directory = join(__dirname, '..', 'build', 'appx');
  mkdirSync(directory, { recursive: true });
  for (const [name, size] of [['StoreLogo.png', 50], ['Square150x150Logo.png', 150], ['Square44x44Logo.png', 44]]) {
    const file = join(directory, name);
    if (!existsSync(file)) writeFileSync(file, icon.resize({ width: size, height: size, quality: 'best' }).toPNG());
  }
  app.quit();
}).catch((error) => { console.error(error.message); app.exit(1); });
