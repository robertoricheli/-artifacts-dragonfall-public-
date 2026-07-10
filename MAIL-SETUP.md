# E-mail — Esqueci a senha

O jogo envia a **senha por e-mail** quando o jogador usa *Esqueci a senha* e o e-mail está cadastrado.

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

Variáveis `DF_SMTP_HOST`, `DF_SMTP_USER`, `DF_SMTP_PASS`, `DF_MAIL_FROM` — ver `render.yaml`.

