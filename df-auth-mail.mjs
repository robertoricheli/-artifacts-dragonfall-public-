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

/**
 * Textos do e-mail por idioma da conta (`language` em df-auth). Conta sem idioma → en.
 * Novo idioma (es/de/ja/zh): copiar o bloco `en` com as mesmas chaves. `{password}` = senha.
 */
const MAIL_DEFAULT_LANG = "en";
const MAIL_TEXT = {
  en: {
    subjectChanged: "Dragonfall — password changed in your profile",
    subjectSetupTest: "[TEST] Dragonfall — email setup",
    subjectReminder: "Dragonfall — temporary recovery password",
    introChangedNotice: "You changed your password in your Dragonfall profile. If this wasn't you, use Forgot password right away.",
    introChanged: "You changed your password in your Dragonfall profile. Here is the new password you chose:",
    introSetupTest: "This is a TEST email for SMTP setup. It is not a password recovery, and your game password has NOT changed.",
    introReminder: "You requested a password recovery on Dragonfall. We generated a new TEMPORARY password (the old one no longer works).",
    greeting: "Hello,",
    setupTestWorking: "If you received this email, sending is working.",
    noticeOldPassword: "Your old password no longer works. Use the new password you set in your profile.",
    passwordLineChanged: "Your new password is: {password}",
    passwordLineReminder: "Your temporary password is: {password}",
    nextSetupTest: "Close this email. To actually recover your password, use Forgot password in the game.",
    nextChangedNotice: "If you didn't request this, recover your account with Forgot password.",
    nextChanged: "Use it on the LOG IN screen to enter the game.",
    nextReminder: "Use it on the LOG IN screen, then change your password in your profile.",
    footerText: "If you didn't request this, ignore this email and change your password in your profile if you can log in.",
    signature: "— Dragonfall",
    htmlSetupTest: "<p>If you received this email, sending is working.</p><p><strong>Your game password has not changed.</strong> To recover your real password, use <em>Forgot password</em> in the game.</p>",
    htmlChangedNotice: "<p>Your old password <strong>no longer works</strong>. Use the new password you set in your profile.</p>",
    htmlPasswordLabelChanged: "Your <strong>new</strong> password is:",
    htmlPasswordLabelReminder: "Your <strong>temporary</strong> password is:",
    htmlNextChanged: "Use it on the <strong>LOG IN</strong> screen to enter the game.",
    htmlNextReminder: "Use it on the <strong>LOG IN</strong> screen, then change your password in your profile.",
    htmlFooter: "If you didn't request this, ignore this email.",
  },
  pt: {
    subjectChanged: "Dragonfall — senha alterada no perfil",
    subjectSetupTest: "[TESTE] Dragonfall — configuração de e-mail",
    subjectReminder: "Dragonfall — senha temporária de recuperação",
    introChangedNotice: "Você alterou sua senha no perfil do Dragonfall. Se não foi você, use Esqueci a senha imediatamente.",
    introChanged: "Você alterou sua senha no perfil do Dragonfall. Abaixo está a nova senha que você escolheu:",
    introSetupTest: "Este é um e-mail de TESTE de configuração SMTP. Não é recuperação de senha e sua senha do jogo NÃO mudou.",
    introReminder: "Você pediu recuperação de senha no Dragonfall. Geramos uma senha TEMPORÁRIA nova (a antiga foi invalidada).",
    greeting: "Olá,",
    setupTestWorking: "Se você recebeu este e-mail, o envio está funcionando.",
    noticeOldPassword: "Sua senha antiga não funciona mais. Use a nova senha que você definiu no perfil.",
    passwordLineChanged: "Sua senha cadastrada é: {password}",
    passwordLineReminder: "Sua senha temporária é: {password}",
    nextSetupTest: "Feche este e-mail. Para recuperar sua senha de verdade, use Esqueci a senha no jogo.",
    nextChangedNotice: "Se você não pediu isso, recupere a conta com Esqueci a senha.",
    nextChanged: "Use-a na tela de LOGIN para entrar no jogo.",
    nextReminder: "Use-a na tela de LOGIN e depois altere a senha no perfil.",
    footerText: "Se você não pediu isso, ignore este e-mail e altere a senha no perfil se conseguir entrar.",
    signature: "— Dragonfall",
    htmlSetupTest: "<p>Se você recebeu este e-mail, o envio está funcionando.</p><p><strong>Sua senha do jogo não mudou.</strong> Para recuperar a senha real, use <em>Esqueci a senha</em> no jogo.</p>",
    htmlChangedNotice: "<p>Sua senha antiga <strong>não funciona mais</strong>. Use a nova senha que você definiu no perfil.</p>",
    htmlPasswordLabelChanged: "Sua senha <strong>cadastrada</strong> é:",
    htmlPasswordLabelReminder: "Sua senha <strong>temporária</strong> é:",
    htmlNextChanged: "Use-a na tela de <strong>LOGIN</strong> para entrar no jogo.",
    htmlNextReminder: "Use-a na tela de <strong>LOGIN</strong> e depois altere a senha no perfil.",
    htmlFooter: "Se você não pediu isso, ignore este e-mail.",
  },
};

function mailTextFor(language) {
  const lang = Object.prototype.hasOwnProperty.call(MAIL_TEXT, language) ? language : MAIL_DEFAULT_LANG;
  return MAIL_TEXT[lang];
}

function withPassword(template, password) {
  return String(template).split("{password}").join(String(password ?? ""));
}

export function buildMessage(password, kind = "reminder", language = null) {
  const m = mailTextFor(language);
  const subject = kind === "changed" || kind === "changed-notice"
    ? m.subjectChanged
    : kind === "setup-test"
      ? m.subjectSetupTest
      : m.subjectReminder;
  const intro = kind === "changed-notice"
    ? m.introChangedNotice
    : kind === "changed"
    ? m.introChanged
    : kind === "setup-test"
      ? m.introSetupTest
      : m.introReminder;
  const text = [
    m.greeting,
    "",
    intro,
    "",
    kind === "setup-test"
      ? m.setupTestWorking
      : kind === "changed-notice"
        ? m.noticeOldPassword
      : withPassword(kind === "changed" ? m.passwordLineChanged : m.passwordLineReminder, password),
    "",
    kind === "setup-test"
      ? m.nextSetupTest
      : kind === "changed-notice"
        ? m.nextChangedNotice
      : kind === "changed"
        ? m.nextChanged
        : m.nextReminder,
    "",
    m.footerText,
    "",
    m.signature,
  ].join("\n");
  const html = `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.55;color:#1a1428;max-width:480px">
      <p>${m.greeting}</p>
      <p>${intro}</p>
      ${kind === "setup-test"
        ? m.htmlSetupTest
        : kind === "changed-notice"
          ? m.htmlChangedNotice
        : `<p>${kind === "changed" ? m.htmlPasswordLabelChanged : m.htmlPasswordLabelReminder}</p>
      <p style="font-size:1.35rem;font-weight:700;letter-spacing:0.05em;color:#5a3a8a;margin:16px 0">${password}</p>
      <p>${kind === "changed" ? m.htmlNextChanged : m.htmlNextReminder}</p>`}
      <p style="color:#666;font-size:0.88rem;margin-top:24px">${m.htmlFooter}</p>
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

async function sendViaResend(to, password, kind, language) {
  const apiKey = process.env.DF_RESEND_API_KEY;
  const from = process.env.DF_MAIL_FROM;
  if (!apiKey || !from) throw new Error("MAIL_NOT_CONFIGURED");
  const { subject, html, text } = buildMessage(password, kind, language);
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

async function sendViaSmtp(to, password, kind, language) {
  const cfg = loadSmtpConfig();
  if (!cfg?.host || !cfg?.user || !cfg?.pass) {
    throw new Error("MAIL_NOT_CONFIGURED");
  }
  const transporter = createSmtpTransport(cfg);
  const { subject, html, text } = buildMessage(password, kind, language);
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

async function deliverPasswordEmail(to, password, kind, language) {
  if (process.env.DF_RESEND_API_KEY) {
    await sendViaResend(to, password, kind, language);
    return;
  }
  try {
    await sendViaSmtp(to, password, kind, language);
  } catch (e) {
    const code = classifyMailError(e);
    const err = new Error(code);
    err.cause = e;
    throw err;
  }
}

/** `language` = idioma da conta (en|pt|…); null/desconhecido → en. */
export async function sendPasswordResetEmail(to, password, language = null) {
  await deliverPasswordEmail(to, password, "reminder", language);
}

/** E-mail de teste ao rodar CONFIGURAR-EMAIL.bat — NÃO é recuperação de senha. */
export async function sendMailConfigTestEmail(to, language = null) {
  await deliverPasswordEmail(to, "", "setup-test", language);
}

export async function sendPasswordChangedEmail(to, password, language = null) {
  await deliverPasswordEmail(to, password, "changed", language);
}

/** Aviso de troca de senha sem enviar a senha em texto. */
export async function sendPasswordChangedNoticeEmail(to, language = null) {
  await deliverPasswordEmail(to, "", "changed-notice", language);
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
