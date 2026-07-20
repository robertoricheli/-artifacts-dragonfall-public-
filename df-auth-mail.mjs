/**
 * Dragonfall — envio de e-mail para recuperação de senha.
 *
 * Configuração (uma das opções):
 * 1) server/data/mail-config.json (copie de mail-config.example.json)
 * 2) Variáveis de ambiente: DF_SMTP_* ou DF_RESEND_API_KEY + DF_MAIL_FROM
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "data", "mail-config.json");
const ENV_PATH = path.join(__dirname, ".env");

function loadDotEnv() {
  try {
    if (!fs.existsSync(ENV_PATH)) return;
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (e) {
    console.warn("[mail] .env:", e.message);
  }
}

loadDotEnv();

function loadFileConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data?.host || !data?.user) return null;
    return {
      host: String(data.host),
      port: Number(data.port || 587),
      secure: !!data.secure,
      user: String(data.user),
      pass: String(data.pass || ""),
      from: String(data.from || data.user),
    };
  } catch (e) {
    console.warn("[mail] config inválida:", e.message);
    return null;
  }
}

function loadSmtpConfig() {
  if (process.env.DF_SMTP_HOST && process.env.DF_SMTP_USER) {
    return {
      host: process.env.DF_SMTP_HOST,
      port: Number(process.env.DF_SMTP_PORT || 587),
      secure: process.env.DF_SMTP_SECURE === "true",
      user: process.env.DF_SMTP_USER,
      pass: process.env.DF_SMTP_PASS || "",
      from: process.env.DF_MAIL_FROM || process.env.DF_SMTP_USER,
    };
  }
  return loadFileConfig();
}

export function isMailConfigured() {
  if (process.env.DF_RESEND_API_KEY && process.env.DF_MAIL_FROM) return true;
  const smtp = loadSmtpConfig();
  return !!(smtp?.host && smtp?.user && smtp?.pass);
}

function buildMessage(password, kind = "reminder") {
  const subject = kind === "changed"
    ? "Dragonfall — senha alterada no perfil"
    : kind === "setup-test"
      ? "[TESTE] Dragonfall — configuração de e-mail"
      : "Dragonfall — senha temporária de recuperação";
  const intro = kind === "changed"
    ? "Você alterou sua senha no perfil do Dragonfall. Abaixo está a nova senha que você escolheu:"
    : kind === "setup-test"
      ? "Este é um e-mail de TESTE de configuração SMTP. Não é recuperação de senha e sua senha do jogo NÃO mudou."
      : "Você pediu recuperação de senha no Dragonfall. Geramos uma senha TEMPORÁRIA nova (a antiga foi invalidada).";
  const text = [
    "Olá,",
    "",
    intro,
    "",
    kind === "setup-test"
      ? "Se você recebeu este e-mail, o envio está funcionando."
      : `Sua senha ${kind === "changed" ? "cadastrada" : "temporária"} é: ${password}`,
    "",
    kind === "setup-test"
      ? "Feche este e-mail. Para recuperar sua senha de verdade, use Esqueci a senha no jogo."
      : kind === "changed"
        ? "Use-a na tela de LOGIN para entrar no jogo."
        : "Use-a na tela de LOGIN e depois altere a senha no perfil.",
    "",
    "Se você não pediu isso, ignore este e-mail e altere a senha no perfil se conseguir entrar.",
    "",
    "— Dragonfall",
  ].join("\n");
  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.55;color:#1a1428;max-width:480px">
      <p>Olá,</p>
      <p>${intro}</p>
      ${kind === "setup-test"
        ? "<p>Se você recebeu este e-mail, o envio está funcionando.</p><p><strong>Sua senha do jogo não mudou.</strong> Para recuperar a senha real, use <em>Esqueci a senha</em> no jogo.</p>"
        : `<p>Sua senha <strong>${kind === "changed" ? "cadastrada" : "temporária"}</strong> é:</p>
      <p style="font-size:1.35rem;font-weight:700;letter-spacing:0.05em;color:#5a3a8a;margin:16px 0">${password}</p>
      <p>${kind === "changed"
        ? "Use-a na tela de <strong>LOGIN</strong> para entrar no jogo."
        : "Use-a na tela de <strong>LOGIN</strong> e depois altere a senha no perfil."}</p>`}
      <p style="color:#666;font-size:0.88rem;margin-top:24px">Se você não pediu isso, ignore este e-mail.</p>
    </div>`;
  return { subject, text, html };
}

function createSmtpTransport(cfg) {
  const isGmail = cfg.host === "smtp.gmail.com" || /@gmail\.com$/i.test(cfg.user);
  if (isGmail) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: { user: cfg.user, pass: cfg.pass },
    });
  }
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure || cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
}

async function sendViaResend(to, password, kind) {
  const apiKey = process.env.DF_RESEND_API_KEY;
  const from = process.env.DF_MAIL_FROM;
  if (!apiKey || !from) throw new Error("MAIL_NOT_CONFIGURED");
  const { subject, html, text } = buildMessage(password, kind);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => "");
    throw new Error("MAIL_FAILED:" + (errBody || r.status));
  }
}

async function sendViaSmtp(to, password, kind) {
  const cfg = loadSmtpConfig();
  if (!cfg?.host || !cfg?.user || !cfg?.pass) {
    throw new Error("MAIL_NOT_CONFIGURED");
  }
  const transporter = createSmtpTransport(cfg);
  const { subject, html, text } = buildMessage(password, kind);
  const info = await transporter.sendMail({
    from: cfg.from,
    to,
    subject,
    text,
    html,
  });
  if (!info?.messageId) {
    throw new Error("MAIL_FAILED:no_message_id");
  }
}

async function deliverPasswordEmail(to, password, kind) {
  if (process.env.DF_RESEND_API_KEY) {
    await sendViaResend(to, password, kind);
    return;
  }
  try {
    await sendViaSmtp(to, password, kind);
  } catch (e) {
    const code = classifyMailError(e);
    const err = new Error(code);
    err.cause = e;
    throw err;
  }
}

export async function sendPasswordResetEmail(to, password) {
  await deliverPasswordEmail(to, password, "reminder");
}

/** E-mail de teste ao rodar CONFIGURAR-EMAIL.bat — NÃO é recuperação de senha. */
export async function sendMailConfigTestEmail(to) {
  await deliverPasswordEmail(to, "", "setup-test");
}

export async function sendPasswordChangedEmail(to, password) {
  await deliverPasswordEmail(to, password, "changed");
}

export function classifyMailError(e) {
  const msg = String(e?.message || e);
  if (msg.includes("MAIL_NOT_CONFIGURED")) return "MAIL_NOT_CONFIGURED";
  if (
    e?.code === "EAUTH"
    || msg.includes("Invalid login")
    || msg.includes("BadCredentials")
    || msg.includes("Username and Password not accepted")
  ) {
    return "MAIL_BAD_CREDENTIALS";
  }
  return "MAIL_FAILED";
}

export function logMailStatusOnBoot() {
  if (isMailConfigured()) {
    const via = process.env.DF_RESEND_API_KEY ? "Resend" : "SMTP";
    console.log(`   E-mail: ${via} configurado (Esqueci a senha)`);
    const cfg = loadSmtpConfig();
    if (cfg && !process.env.DF_RESEND_API_KEY) {
      createSmtpTransport(cfg).verify().then(() => {
        console.log("   E-mail: conexão SMTP verificada");
      }).catch((e) => {
        console.warn("   ⚠️  E-mail: SMTP configurado mas falhou verificação —", e?.message || e);
        console.warn("       Rode: npm run df:setup:mail");
      });
    }
  } else {
    console.warn("   ⚠️  E-mail NÃO configurado — rode: npm run df:setup:mail");
  }
}
