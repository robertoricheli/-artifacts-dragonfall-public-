# E-mail — Esqueci a senha

O jogo gera uma **senha temporária nova** (invalida a anterior) e envia por e-mail quando o jogador usa *Esqueci a senha* e o e-mail está cadastrado. A senha antiga **não** é recuperada de armazenamento reversível.

## Configuração rápida (Gmail)

Na raiz do projeto:

```bash
npm run df:setup:mail
```

Ou no Windows: `server\configurar-email.bat`

1. Ative **Verificação em duas etapas** na conta Google.
2. Crie uma **Senha de app** (Correio).
3. Informe o Gmail e a senha de app no assistente.
4. **Reinicie** `npm run df:serve`.

No terminal deve aparecer: `E-mail: SMTP configurado` e `conexão SMTP verificada`.

## Manual

Copie `server/mail-config.example.json` → `server/data/mail-config.json` e preencha.

`server/data/mail-config.json` **não** vai para o Git.

## Produção (Render)

**Importante:** o jogo local (`jogar-local.bat`) e o Netlify fazem proxy de `/auth` para o **mesmo servidor Render**.  
`CONFIGURAR-EMAIL.bat` no PC **não** afeta Esqueci a senha no jogo — só vale se você rodar o servidor em `server/` **sem** proxy.

No [Dashboard Render](https://dashboard.render.com) → serviço `dragonfall-multiplayer` → **Environment**:

| Variável | Exemplo |
|----------|---------|
| `DATABASE_URL` | (do Postgres do Render) |
| `DF_AUTH_ENC_KEY` | string secreta longa (≥32 chars) — **obrigatória** para `passwordEnc` estável entre deploys |
| `DF_SMTP_HOST` | `smtp.gmail.com` |
| `DF_SMTP_PORT` | `587` |
| `DF_SMTP_USER` | seu Gmail de envio |
| `DF_SMTP_PASS` | senha de app (16 letras) |
| `DF_MAIL_FROM` | `Dragonfall <seu@gmail.com>` |

Se `DATABASE_URL` estiver definida e o Postgres falhar no boot, o servidor **aborta** em produção (não cai para `accounts.json` efêmero).

Depois de salvar, aguarde o redeploy e confira:

```bash
npm run df:check:auth-mail
```

`/health` deve mostrar `"authStore": "postgres"` e `"mailConfigured": true`.

Alternativa: `DF_RESEND_API_KEY` + `DF_MAIL_FROM` (Resend).
