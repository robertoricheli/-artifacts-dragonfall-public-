/**
 * Versão do jogo alinhada ao deploy web (netlify-dist / df-game-view).
 * Monorepo: este arquivo vive em server/ → raiz = ..
 * Pacote Render: arquivos na raiz do repo → raiz = .
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.existsSync(path.join(HERE, "artifacts", "dragonfall"))
  ? HERE
  : path.join(HERE, "..");

export function readGameVersion() {
  if (process.env.DF_GAME_VERSION) return process.env.DF_GAME_VERSION;

  const versionJson = path.join(ROOT, "artifacts", "dragonfall", "netlify-dist", "version.json");
  if (fs.existsSync(versionJson)) {
    try {
      const v = JSON.parse(fs.readFileSync(versionJson, "utf8"));
      if (v.displayVersion) return String(v.displayVersion);
    } catch (_) { /* ignore */ }
  }

  const viewPath = path.join(ROOT, "artifacts", "dragonfall", "js", "df-game-view.js");
  if (fs.existsSync(viewPath)) {
    const m = fs.readFileSync(viewPath, "utf8").match(/DF_DISPLAY_VERSION\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }

  return "1.35.0";
}
