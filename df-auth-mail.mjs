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
 * Novo idioma: copiar o bloco `en` com as mesmas chaves (+ MAIL_HTML_LANG). `{password}` = senha.
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
  es: {
    subjectChanged: "Dragonfall — contraseña cambiada en tu perfil",
    subjectSetupTest: "[PRUEBA] Dragonfall — configuración de correo",
    subjectReminder: "Dragonfall — contraseña temporal de recuperación",
    introChangedNotice: "Cambiaste tu contraseña en tu perfil de Dragonfall. Si no fuiste tú, usa Olvidé mi contraseña de inmediato.",
    introChanged: "Cambiaste tu contraseña en tu perfil de Dragonfall. Esta es la nueva contraseña que elegiste:",
    introSetupTest: "Este es un correo de PRUEBA de la configuración SMTP. No es una recuperación de contraseña y tu contraseña del juego NO cambió.",
    introReminder: "Pediste recuperar tu contraseña en Dragonfall. Generamos una nueva contraseña TEMPORAL (la anterior ya no funciona).",
    greeting: "Hola:",
    setupTestWorking: "Si recibiste este correo, el envío funciona.",
    noticeOldPassword: "Tu contraseña anterior ya no funciona. Usa la nueva contraseña que definiste en tu perfil.",
    passwordLineChanged: "Tu nueva contraseña es: {password}",
    passwordLineReminder: "Tu contraseña temporal es: {password}",
    nextSetupTest: "Cierra este correo. Para recuperar tu contraseña de verdad, usa Olvidé mi contraseña en el juego.",
    nextChangedNotice: "Si no lo pediste tú, recupera tu cuenta con Olvidé mi contraseña.",
    nextChanged: "Úsala en la pantalla de INICIAR SESIÓN para entrar al juego.",
    nextReminder: "Úsala en la pantalla de INICIAR SESIÓN y después cambia tu contraseña en tu perfil.",
    footerText: "Si no lo pediste tú, ignora este correo y cambia tu contraseña en tu perfil si puedes iniciar sesión.",
    signature: "— Dragonfall",
    htmlSetupTest: "<p>Si recibiste este correo, el envío funciona.</p><p><strong>Tu contraseña del juego no cambió.</strong> Para recuperar tu contraseña real, usa <em>Olvidé mi contraseña</em> en el juego.</p>",
    htmlChangedNotice: "<p>Tu contraseña anterior <strong>ya no funciona</strong>. Usa la nueva contraseña que definiste en tu perfil.</p>",
    htmlPasswordLabelChanged: "Tu <strong>nueva</strong> contraseña es:",
    htmlPasswordLabelReminder: "Tu contraseña <strong>temporal</strong> es:",
    htmlNextChanged: "Úsala en la pantalla de <strong>INICIAR SESIÓN</strong> para entrar al juego.",
    htmlNextReminder: "Úsala en la pantalla de <strong>INICIAR SESIÓN</strong> y después cambia tu contraseña en tu perfil.",
    htmlFooter: "Si no lo pediste tú, ignora este correo.",
  },
  de: {
    subjectChanged: "Dragonfall — Passwort in deinem Profil geändert",
    subjectSetupTest: "[TEST] Dragonfall — E-Mail-Einrichtung",
    subjectReminder: "Dragonfall — temporäres Passwort zur Wiederherstellung",
    introChangedNotice: "Du hast dein Passwort in deinem Dragonfall-Profil geändert. Wenn du das nicht warst, nutze sofort „Passwort vergessen“.",
    introChanged: "Du hast dein Passwort in deinem Dragonfall-Profil geändert. Hier ist das neue Passwort, das du gewählt hast:",
    introSetupTest: "Dies ist eine TEST-E-Mail für die SMTP-Einrichtung. Es ist keine Passwort-Wiederherstellung und dein Spielpasswort wurde NICHT geändert.",
    introReminder: "Du hast bei Dragonfall eine Passwort-Wiederherstellung angefordert. Wir haben ein neues TEMPORÄRES Passwort erstellt (das alte funktioniert nicht mehr).",
    greeting: "Hallo,",
    setupTestWorking: "Wenn du diese E-Mail bekommen hast, funktioniert der Versand.",
    noticeOldPassword: "Dein altes Passwort funktioniert nicht mehr. Nutze das neue Passwort, das du in deinem Profil festgelegt hast.",
    passwordLineChanged: "Dein neues Passwort lautet: {password}",
    passwordLineReminder: "Dein temporäres Passwort lautet: {password}",
    nextSetupTest: "Schließ diese E-Mail. Um dein Passwort wirklich wiederherzustellen, nutze „Passwort vergessen“ im Spiel.",
    nextChangedNotice: "Wenn du das nicht angefordert hast, stelle dein Konto über „Passwort vergessen“ wieder her.",
    nextChanged: "Gib es auf dem Bildschirm ANMELDEN ein, um ins Spiel zu kommen.",
    nextReminder: "Gib es auf dem Bildschirm ANMELDEN ein und ändere danach dein Passwort in deinem Profil.",
    footerText: "Wenn du das nicht angefordert hast, ignoriere diese E-Mail und ändere dein Passwort im Profil, falls du dich anmelden kannst.",
    signature: "— Dragonfall",
    htmlSetupTest: "<p>Wenn du diese E-Mail bekommen hast, funktioniert der Versand.</p><p><strong>Dein Spielpasswort wurde nicht geändert.</strong> Um dein echtes Passwort wiederherzustellen, nutze <em>Passwort vergessen</em> im Spiel.</p>",
    htmlChangedNotice: "<p>Dein altes Passwort <strong>funktioniert nicht mehr</strong>. Nutze das neue Passwort, das du in deinem Profil festgelegt hast.</p>",
    htmlPasswordLabelChanged: "Dein <strong>neues</strong> Passwort lautet:",
    htmlPasswordLabelReminder: "Dein <strong>temporäres</strong> Passwort lautet:",
    htmlNextChanged: "Gib es auf dem Bildschirm <strong>ANMELDEN</strong> ein, um ins Spiel zu kommen.",
    htmlNextReminder: "Gib es auf dem Bildschirm <strong>ANMELDEN</strong> ein und ändere danach dein Passwort in deinem Profil.",
    htmlFooter: "Wenn du das nicht angefordert hast, ignoriere diese E-Mail.",
  },
  ja: {
    subjectChanged: "Dragonfall — プロフィールのパスワードが変更されました",
    subjectSetupTest: "[テスト] Dragonfall — メール設定",
    subjectReminder: "Dragonfall — 復旧用の仮パスワード",
    introChangedNotice: "Dragonfallのプロフィールでパスワードが変更されました。お心当たりがない場合は、すぐに「パスワードを忘れた」をご利用ください。",
    introChanged: "Dragonfallのプロフィールでパスワードが変更されました。新しく設定されたパスワードは次のとおりです。",
    introSetupTest: "これはSMTP設定のテストメールです。パスワードの復旧ではなく、ゲームのパスワードは変更されていません。",
    introReminder: "Dragonfallでパスワードの復旧がリクエストされました。新しい仮パスワードを発行しました（以前のパスワードは使えなくなりました）。",
    greeting: "こんにちは。",
    setupTestWorking: "このメールが届いていれば、送信は正常に機能しています。",
    noticeOldPassword: "以前のパスワードは使えなくなりました。プロフィールで設定した新しいパスワードをご利用ください。",
    passwordLineChanged: "新しいパスワード：{password}",
    passwordLineReminder: "仮パスワード：{password}",
    nextSetupTest: "このメールは閉じてください。実際にパスワードを復旧するには、ゲーム内の「パスワードを忘れた」をご利用ください。",
    nextChangedNotice: "お心当たりがない場合は、「パスワードを忘れた」からアカウントを復旧してください。",
    nextChanged: "ログイン画面でこのパスワードを入力して、ゲームに入ってください。",
    nextReminder: "ログイン画面でこのパスワードを入力し、その後プロフィールでパスワードを変更してください。",
    footerText: "お心当たりがない場合は、このメールを無視してください。ログインできる場合は、プロフィールでパスワードを変更してください。",
    signature: "— Dragonfall",
    htmlSetupTest: "<p>このメールが届いていれば、送信は正常に機能しています。</p><p><strong>ゲームのパスワードは変更されていません。</strong>実際にパスワードを復旧するには、ゲーム内の<em>「パスワードを忘れた」</em>をご利用ください。</p>",
    htmlChangedNotice: "<p>以前のパスワードは<strong>使えなくなりました</strong>。プロフィールで設定した新しいパスワードをご利用ください。</p>",
    htmlPasswordLabelChanged: "<strong>新しい</strong>パスワード：",
    htmlPasswordLabelReminder: "<strong>仮</strong>パスワード：",
    htmlNextChanged: "<strong>ログイン</strong>画面でこのパスワードを入力して、ゲームに入ってください。",
    htmlNextReminder: "<strong>ログイン</strong>画面でこのパスワードを入力し、その後プロフィールでパスワードを変更してください。",
    htmlFooter: "お心当たりがない場合は、このメールを無視してください。",
  },
  zh: {
    subjectChanged: "Dragonfall — 你的个人资料中的密码已更改",
    subjectSetupTest: "[测试] Dragonfall — 邮件设置",
    subjectReminder: "Dragonfall — 用于找回的临时密码",
    introChangedNotice: "你在Dragonfall个人资料中更改了密码。如果不是你本人操作，请立即使用“忘记密码”。",
    introChanged: "你在Dragonfall个人资料中更改了密码。以下是你设置的新密码：",
    introSetupTest: "这是一封SMTP设置测试邮件。它不是密码找回邮件，你的游戏密码没有更改。",
    introReminder: "你在Dragonfall申请了找回密码。我们已生成新的临时密码（旧密码已失效）。",
    greeting: "你好：",
    setupTestWorking: "如果你收到了这封邮件，说明发送功能正常。",
    noticeOldPassword: "你的旧密码已失效。请使用你在个人资料中设置的新密码。",
    passwordLineChanged: "你的新密码是：{password}",
    passwordLineReminder: "你的临时密码是：{password}",
    nextSetupTest: "请关闭这封邮件。如需真正找回密码，请在游戏中使用“忘记密码”。",
    nextChangedNotice: "如果这不是你本人的请求，请通过“忘记密码”找回你的账号。",
    nextChanged: "请在登录界面输入此密码进入游戏。",
    nextReminder: "请在登录界面输入此密码，然后在个人资料中更改密码。",
    footerText: "如果这不是你本人的请求，请忽略这封邮件；如果你能登录，请在个人资料中更改密码。",
    signature: "— Dragonfall",
    htmlSetupTest: "<p>如果你收到了这封邮件，说明发送功能正常。</p><p><strong>你的游戏密码没有更改。</strong>如需找回真实密码，请在游戏中使用<em>“忘记密码”</em>。</p>",
    htmlChangedNotice: "<p>你的旧密码<strong>已失效</strong>。请使用你在个人资料中设置的新密码。</p>",
    htmlPasswordLabelChanged: "你的<strong>新</strong>密码是：",
    htmlPasswordLabelReminder: "你的<strong>临时</strong>密码是：",
    htmlNextChanged: "请在<strong>登录</strong>界面输入此密码进入游戏。",
    htmlNextReminder: "请在<strong>登录</strong>界面输入此密码，然后在个人资料中更改密码。",
    htmlFooter: "如果这不是你本人的请求，请忽略这封邮件。",
  },
};
/** <html lang> do e-mail por idioma da conta. */
const MAIL_HTML_LANG = { en: "en", pt: "pt-BR", es: "es", de: "de", ja: "ja", zh: "zh-Hans" };
/** Fontes CJK do sistema do leitor de e-mail antes do fallback latino. */
const MAIL_FONT = {
  ja: "'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',Meiryo,'Segoe UI',Arial,sans-serif",
  zh: "'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Segoe UI',Arial,sans-serif",
};

function mailLang(language) {
  return Object.prototype.hasOwnProperty.call(MAIL_TEXT, language) ? language : MAIL_DEFAULT_LANG;
}

function mailTextFor(language) {
  return MAIL_TEXT[mailLang(language)];
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
  const lang = mailLang(language);
  const html = `<!DOCTYPE html>
<html lang="${MAIL_HTML_LANG[lang] || lang}"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body>
    <div style="font-family:${MAIL_FONT[lang] || "Segoe UI,Arial,sans-serif"};line-height:1.55;color:#1a1428;max-width:480px">
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
    </div>
</body></html>`;
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
