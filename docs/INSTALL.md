# Installation manuelle (si `install.js` ne trouve pas ses repères)

`node install.js "<agent-os>"` fait tout ceci automatiquement. Cette page décrit les mêmes gestes à la main, pour une copie d'Agentic OS dont `server.js` ou `index.html` auraient été réorganisés.

## 1. Fichiers à copier dans `agent-os/`

| Source (ce dépôt) | Destination |
|---|---|
| `jarvis/lib/jarvis.js` | `lib/jarvis.js` — cœur serveur : clé éphémère OpenAI Realtime, les 47 outils, persona, verrou des plans de lancement |
| `jarvis/lib/routes.js` | `lib/routes.js` — catalogue automatique des routes de l'API (outil `api_routes`) |
| `jarvis/lib/jarvis-routes.js` | `lib/jarvis-routes.js` — routes HTTP `/api/jarvis/*` (+ `/api/telegram/inbox` et `/send`) |
| `jarvis/public/jarvis.css` | `public/jarvis.css` |
| `jarvis/public/js/jarvis.js` | `public/js/jarvis.js` — client WebRTC, overlay plein écran, fenêtres, sous-titres |
| `jarvis/scripts/jarvis-desktop.py` | `scripts/jarvis-desktop.py` — contrôle du PC Windows (Python/ctypes) |
| `jarvis/docs/JARVIS-ACCES.md` | `docs/JARVIS-ACCES.md` — inventaire des accès et limites |

## 2. `server.js`

Dans le préambule, après les autres `require("./lib/…")` :

```js
const jarvisRoutes = require("./lib/jarvis-routes");
```

Dans le gestionnaire de requêtes, là où `p` (chemin), `url`, `json(res, status, obj)` et `readBody(req)` sont disponibles, avant les autres routes `/api` (par exemple juste avant `if (p === "/api/health")`) :

```js
// ===== JARVIS (routes dans lib/jarvis-routes.js) =====
if (await jarvisRoutes.handle({ req, res, url, p, json, readBody })) return;
```

Optionnel, dans la réponse de `/api/health` : `jarvis: { configured: require("./lib/jarvis").configured() }`.

## 3. `public/index.html`

```html
<link rel="stylesheet" href="jarvis.css" />                       <!-- dans <head> -->
<button class="btn btn-ghost btn-jarvis" id="btn-jarvis" title="Activer / désactiver Jarvis (Alt+J)"><span class="hex">&#11041;</span>Jarvis</button>   <!-- dans la barre du haut -->
<script src="js/jarvis.js"></script>                              <!-- après js/core.js -->
<script>AgentOS.boot(); Jarvis.boot();</script>                   <!-- Jarvis.boot() après AgentOS.boot() -->
```

## 4. `public/js/core.js` — deux signaux utilisés par Jarvis

Après le rendu d'une page (fonction `render`/`navigate`) :

```js
document.dispatchEvent(new CustomEvent("agentos:navigated", { detail: { page: name, title: def.title } }));
```

Mode embarqué (`?embed=1`, utilisé par les fenêtres de pages de l'appel) : si `location.search` contient `embed=1`, ajouter la classe `embed` sur `<body>` (le CSS masque menu et barre) et ne pas lancer la salve de rafraîchissement au chargement. Exporter `embed` et `pages` dans l'objet `AgentOS`.

## 5. Page Paramètres (optionnel)

Le formulaire de réglages (voix, style, instructions) est aussi accessible depuis le panneau ⚙ de l'appel. Pour l'afficher dans la page Paramètres :

```js
// dans le gabarit : <h2>Jarvis</h2><div id="jarvis-settings"><span class="spin"></span></div>
if (typeof Jarvis !== "undefined") Jarvis.settingsForm(el.querySelector("#jarvis-settings")).catch(() => {});
```

## 6. Configuration

- **Clé OpenAI** (obligatoire) : coffre Agentic OS (champ `openai`) ou `.env` à la racine du projet (`OpenAI=sk-…`). Le serveur fabrique une clé éphémère par appel ; la clé réelle ne va jamais au navigateur.
- **Voix** : `cedar` par défaut (ou `marin`), aperçu depuis les réglages (`/api/jarvis/voice-preview`).
- **Telegram** (optionnel) : `telegram_token` + `telegram_chat_id` dans le coffre. Le long-poll du serveur (lib/telegram.js) doit stocker les messages texte pour que `/api/telegram/inbox` fonctionne.
- **Contrôle du PC** (optionnel, Windows) : Python 3 et `pip install pillow`. Les scripts PowerShell multi-P/Invoke sont bloqués par Defender (AMSI), d'où Python/ctypes.

## 7. Vérifier

```
npm start
curl http://localhost:4200/api/jarvis/status
```

puis dans le navigateur : bouton « Jarvis » (ou Alt+J) → autoriser le micro → parler. Mode démo sans OpenAI : `http://localhost:4200/?jvdemo=1`.
