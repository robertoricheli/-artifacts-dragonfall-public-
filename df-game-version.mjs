/**
 * Versão do jogo alinhada ao deploy web (netlify-dist / df-game-view).
 * Monorepo: este arquivo vive em server/ → raiz = ..
 * Pacote Render: arquivos na raiz do repo → raiz = .
 *
 * `server/game-version.json` é gravado por `npm run df:build` para o
 * Render (rootDir=server) sempre reportar a mesma versão do cliente.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.existsSync(path.join(HERE, "artifacts", "dragonfall"))
  ? HERE
  : path.join(HERE, "..");

function readJsonVersion(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const v = JSON.parse(raw);
    if (v.displayVersion) return String(v.displayVersion);
    if (v.version) return String(v.version);
  } catch (_) { /* ignore */ }
  return null;
}

export function readGameVersion() {
  if (process.env.DF_GAME_VERSION) return process.env.DF_GAME_VERSION;

  // Preferido: espelho gerado no build (junto do servidor no Render).
  const serverMirror = path.join(HERE, "game-version.json");
  if (fs.existsSync(serverMirror)) {
    const v = readJsonVersion(serverMirror);
    if (v) return v;
  }

  const versionJson = path.join(ROOT, "artifacts", "dragonfall", "netlify-dist", "version.json");
  if (fs.existsSync(versionJson)) {
    const v = readJsonVersion(versionJson);
    if (v) return v;
  }

  const viewPath = path.join(ROOT, "artifacts", "dragonfall", "js", "df-game-view.js");
  if (fs.existsSync(viewPath)) {
    const m = fs.readFileSync(viewPath, "utf8").match(/DF_DISPLAY_VERSION\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }

  return "1.35.0";
}
