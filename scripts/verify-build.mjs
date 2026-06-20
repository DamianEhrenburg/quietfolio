import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const requiredFiles = [
  "dist-electron/main.js",
  "dist-electron/preload.cjs",
  "out/renderer/index.html"
];

for (const relativePath of requiredFiles) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Missing build artifact: ${relativePath}`);
  }
}

const mainBundle = fs.readFileSync(path.join(root, "dist-electron/main.js"), "utf8");
const requiredMainMarkers = [
  'from "better-sqlite3"',
  "ELECTRON_RENDERER_URL",
  "../out/renderer/index.html"
];

for (const marker of requiredMainMarkers) {
  if (!mainBundle.includes(marker)) {
    throw new Error(`Main bundle is missing expected marker: ${marker}`);
  }
}

if (mainBundle.includes("Could not locate the bindings file")) {
  throw new Error("better-sqlite3 was bundled instead of being externalized");
}

const rendererDirectory = path.join(root, "out/renderer");
const html = fs.readFileSync(path.join(rendererDirectory, "index.html"), "utf8");
const assetPaths = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map(
  (match) => match[1]
);

if (assetPaths.length === 0) {
  throw new Error("Renderer HTML does not reference any built assets");
}

for (const assetPath of assetPaths) {
  if (!fs.existsSync(path.join(rendererDirectory, assetPath))) {
    throw new Error(`Renderer asset is missing: ${assetPath}`);
  }
}

console.log(`Build verification passed (${assetPaths.length} renderer assets checked).`);
