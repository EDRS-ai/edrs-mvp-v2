// Wenduje Leaflet z npm do public/vendor/ (B6 — bez unpkg na produkcji).
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "leaflet", "dist");
const dst = join(root, "public", "vendor", "leaflet");

mkdirSync(dst, { recursive: true });
for (const f of ["leaflet.js", "leaflet.css"]) {
  cpSync(join(src, f), join(dst, f));
}
cpSync(join(src, "images"), join(dst, "images"), { recursive: true });
console.log("vendor: leaflet ->", dst);
