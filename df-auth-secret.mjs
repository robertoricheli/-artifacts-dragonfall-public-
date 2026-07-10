/**
 * Criptografia reversível da senha do jogador (para Esqueci a senha enviar a senha escolhida).
 * Chave em server/data/.auth-enc-key ou DF_AUTH_ENC_KEY no ambiente.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_PATH = path.join(__dirname, "data", ".auth-enc-key");

function getEncKey() {
  if (process.env.DF_AUTH_ENC_KEY) {
    return crypto.createHash("sha256").update(String(process.env.DF_AUTH_ENC_KEY)).digest();
  }
  try {
    if (fs.existsSync(KEY_PATH)) {
      const hex = fs.readFileSync(KEY_PATH, "utf8").trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
    }
  } catch (e) { /* */ }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  fs.writeFileSync(KEY_PATH, key.toString("hex") + "\n", "utf8");
  return key;
}

export function encryptPassword(plain) {
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptPassword(stored) {
  if (!stored || typeof stored !== "string") return null;
  try {
    const [ivH, tagH, dataH] = stored.split(":");
    if (!ivH || !tagH || !dataH) return null;
    const key = getEncKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivH, "hex"));
    decipher.setAuthTag(Buffer.from(tagH, "hex"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(dataH, "hex")),
      decipher.final(),
    ]).toString("utf8");
    return plain || null;
  } catch (e) {
    return null;
  }
}
