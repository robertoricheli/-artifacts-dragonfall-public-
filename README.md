# Servidor multiplayer Dragonfall

## Teste local

```bash
cd server
npm install
npm start
```

Abre em `http://localhost:8787`. No jogo, use o lobby online ou:

```js
localStorage.setItem("dragonfall:server", "http://localhost:8787");
```

---

## Publicar na internet — Render (recomendado)

1. Crie conta em [https://render.com](https://render.com).
2. **New** → **Web Service** → conecte o repositório Git do projeto.
3. Configuração:
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
4. Em **Environment** adicione (opcional):
   - `CORS_ORIGIN` = `*` ou a URL do seu site Netlify (ex. `https://seu-jogo.netlify.app`)
5. Deploy. Copie a URL pública, algo como:
   - `https://dragonfall-multiplayer.onrender.com`

### Colocar a URL no jogo (uma vez)

Edite `artifacts/dragonfall/js/df-server-config.js`:

```js
window.__DF_DEFAULT_SERVER__ = "https://SUA-URL.onrender.com";
```

Rode o build Netlify:

```bash
node scripts/prepare-netlify-deploy.mjs
```

Publique `artifacts/dragonfall/netlify-dist` de novo.

**Ou** cada jogador no lobby: cola a URL em “Servidor” → **Salvar endereço do servidor**.

> Render free “dorme” após ~15 min sem uso. O primeiro acesso pode levar 30–60 s para acordar.

---

## Publicar — Railway

1. [https://railway.app](https://railway.app) → New Project → Deploy from GitHub.
2. Selecione a pasta `server/` (ou use `server/railway.toml`).
3. Gere domínio público em **Settings → Networking**.
4. Use essa URL como acima.

---

## Blueprint Render (automático)

Se o repositório tiver `server/render.yaml`:

**New** → **Blueprint** → selecione o repo → Render cria o serviço `dragonfall-multiplayer`.

---

## API rápida

| Rota | Descrição |
|------|-----------|
| `GET /` | Info JSON |
| `GET /health` | Health check |

Socket.IO na mesma porta (eventos: `create_room`, `join_room`, `game_action`, etc.).
