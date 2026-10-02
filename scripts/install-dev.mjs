import fs from "node:fs";
import path from "node:path";

const PLUGIN_ID = "pi-agent";
const targetDir =
  process.argv[2] || process.env.PI_AGENT_DEV_DIR || process.env.OBSIDIAN_PI_DEV_DIR;
const files = ["main.js", "manifest.json", "styles.css"];

if (!targetDir) {
  console.error("Usage: npm run dev:install -- /path/to/vault/.obsidian/plugins/pi-agent");
  console.error("Or set PI_AGENT_DEV_DIR=/path/to/vault/.obsidian/plugins/pi-agent");
  console.error("The legacy OBSIDIAN_PI_DEV_DIR variable is still supported for local setups.");
  process.exit(1);
}

// This script overwrites three files in whatever directory it is pointed at, so it has to
// know that directory is this plugin's folder before it writes. Pointed at another
// plugin's folder it used to replace that plugin's bundle and manifest with this one,
// destroying it without a backup or a warning.
const targetManifest = path.join(targetDir, "manifest.json");
if (fs.existsSync(targetManifest)) {
  let installedId;
  try {
    installedId = JSON.parse(fs.readFileSync(targetManifest, "utf8")).id;
  } catch (error) {
    console.error(
      `Refusing to install into ${targetDir}: its manifest.json cannot be read (${error.message}).`
    );
    console.error("Move that directory aside, or point the script at an empty one.");
    process.exit(1);
  }
  if (installedId !== PLUGIN_ID) {
    console.error(
      `Refusing to install into ${targetDir}: it holds the plugin "${installedId ?? "unknown"}", not "${PLUGIN_ID}".`
    );
    console.error("Point the script at this plugin's own folder, or at an empty one.");
    process.exit(1);
  }
}

fs.mkdirSync(targetDir, { recursive: true });

for (const file of files) {
  fs.copyFileSync(file, path.join(targetDir, file));
  console.log(`Copied ${file} -> ${targetDir}`);
}

console.log("\nDev install complete. Reload Obsidian or disable/enable the Pi Agent plugin.");
