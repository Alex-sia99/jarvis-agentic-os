# Jarvis pour Agentic OS

Jarvis est l'assistant vocal temps réel d'**Agentic OS** : un overlay plein écran (bouton « Jarvis » en haut à droite ou `Alt+J`) qui écoute, répond à la voix et agit sur la plateforme — ouvrir une page, lire ce qui s'y affiche, consulter les stats d'une chaîne, proposer des idées d'une machine, préparer puis lancer une création après ton accord, envoyer un message Telegram, interroger le second cerveau, piloter le PC.

Ce dépôt contient **tout ce qu'il faut pour installer Jarvis dans une copie d'Agentic OS** : les fichiers du module et un installateur qui fait les branchements.

## Ce que Jarvis sait faire

- **Parler et écouter en temps réel** — OpenAI Realtime en WebRTC, voix `cedar` (ou `marin`), sous-titres à l'écran, consigne de ton réglable, aperçu des voix dans les réglages.
- **Être le gardien d'Agentic OS, rien d'autre** — il n'invente jamais de fonctionnalité : un lexique de la plateforme (`platform_lookup`) relie ce que tu nommes à la page, la machine ou l'outil correspondant ; s'il ne reconnaît pas un mot, il pose la question.
- **Accès universel à l'API locale** — `api_routes` liste toutes les routes de `server.js` (catalogue extrait automatiquement du code), puis `agentos_api` les appelle.
- **Travailler dans les pages** — `open_page` ouvre une page de la plateforme dans une fenêtre déplaçable de l'appel (iframe `?embed=1`), `page_read` lit son contenu, `page_act` clique et remplit.
- **Accompagner une création, jamais la lancer seul** — `machine_run` fonctionne en deux temps avec un verrou serveur : un plan (sujet, réglages, devis, ce qui manque) → tes réponses → « on lance ? » → lancement seulement après ton oui explicite.
- **Rapports** — `channel_stats` (chaîne YouTube, période), `machine_idea` (idées réelles d'une machine), `machine_info`, programme du jour, mémoire persistante.
- **Hors plateforme** — recherche web, Claude Code et Hermès en tâches asynchrones, Kie (images/vidéos), Telegram (envoi + boîte de réception des réponses), contrôle du PC Windows (capture, fenêtres, souris).

L'inventaire complet des 47 outils, des accès et des limites est dans [`jarvis/docs/JARVIS-ACCES.md`](jarvis/docs/JARVIS-ACCES.md).

## Prérequis

- Une installation d'**Agentic OS** (le serveur Node zéro dépendance, `agent-os/`) datant d'au moins fin octobre 2026 : Jarvis s'appuie sur ses bibliothèques (`lib/vault.js`, `store.js`, `claude.js`, `hermes.js`, `telegram.js` avec boîte de réception, `tasks.js`, `studio.js`, `bank.js`, `scrap.js`, `google.js`, `kie.js`, `files.js`, `machines/*`).
- **Node.js ≥ 18**.
- Une **clé OpenAI** (API Realtime + `gpt-4o-mini-tts` pour l'aperçu des voix).
- Optionnel : **Python 3 + Pillow** (`pip install pillow`) pour le contrôle du PC Windows ; un **bot Telegram** (token + chat id dans le coffre) pour l'envoi et la boîte de réception.

## Installation

```bash
git clone https://github.com/Alex-sia99/jarvis-agentic-os.git
cd jarvis-agentic-os
node install.js "C:\chemin\vers\agent-os" --dry-run   # montre ce qui sera fait
node install.js "C:\chemin\vers\agent-os"             # installe
```

L'installateur :

1. copie `lib/jarvis.js`, `lib/routes.js`, `lib/jarvis-routes.js`, `public/jarvis.css`, `public/js/jarvis.js`, `scripts/jarvis-desktop.py`, `docs/JARVIS-ACCES.md` (les fichiers remplacés sont sauvegardés en `*.bak-jarvis`) ;
2. branche les routes dans `server.js` (une ligne de `require` + une ligne dans le gestionnaire de requêtes, avant `/api/health`) ;
3. ajoute dans `public/index.html` la feuille de style, le bouton « Jarvis », le script et `Jarvis.boot()` ;
4. vérifie que `public/js/core.js` émet l'événement `agentos:navigated` et gère le mode `?embed=1`, et te le dit sinon.

Il est idempotent (le relancer ne change rien si tout est en place) ; `--remove` retire les branchements. Les gestes à la main sont décrits dans [`docs/INSTALL.md`](docs/INSTALL.md).

Ensuite :

1. renseigne la clé OpenAI — coffre Agentic OS (Paramètres → Connexions, champ OpenAI) ou `.env` à la racine du projet (`OpenAI=sk-…`) ; le serveur fabrique une **clé éphémère par appel**, la clé réelle ne quitte jamais le serveur ;
2. redémarre le serveur (`npm start` dans `agent-os/`) ;
3. ouvre `http://localhost:4200`, clique sur **Jarvis** (ou `Alt+J`), autorise le micro, parle.

Sans clé OpenAI, l'interface se visite en mode démo : `http://localhost:4200/?jvdemo=1`.

## Réglages

Dans l'appel (panneau ⚙) ou dans la page Paramètres si tu y branches le formulaire (voir `docs/INSTALL.md`) : voix, vitesse, consigne de ton (`VOICE_STYLE`), instructions supplémentaires. Les réglages sont stockés dans `data/jarvis-config.json`, la mémoire dans `data/jarvis-memory.json`, le programme du jour dans `data/jarvis-program.json` (dossier `data/` d'Agentic OS, hors git).

## Routes ajoutées

| Route | Rôle |
|---|---|
| `GET /api/jarvis/status`, `GET/PATCH /api/jarvis/config` | état et réglages |
| `POST /api/jarvis/session` | clé éphémère OpenAI Realtime + instructions + outils |
| `POST /api/jarvis/tool` | exécution d'un outil côté serveur |
| `GET /api/jarvis/events` (SSE), `GET/POST /api/jarvis/log`, `GET /api/jarvis/job` | journal, événements, tâches asynchrones |
| `GET /api/jarvis/memory`, `GET /api/jarvis/program` | mémoire, programme du jour |
| `GET /api/jarvis/voice-preview?voice=cedar` | extrait mp3 d'une voix |
| `GET /api/telegram/inbox`, `POST /api/telegram/send` | boîte de réception et envoi Telegram (si `lib/telegram.js` les expose) |

## Sécurité

- La clé OpenAI reste côté serveur ; le navigateur ne reçoit qu'une clé éphémère.
- Jarvis exécute de vraies actions (lancement de machines, envoi Telegram, clics sur le PC) : garde le serveur sur `localhost` ou derrière une authentification, et n'expose pas le port 4200 sur Internet.
- Aucun secret dans ce dépôt : clés et jetons vivent dans le coffre chiffré d'Agentic OS ou dans ton `.env`.

## Structure du dépôt

```
install.js                 installateur (Node, sans dépendance)
jarvis/lib/jarvis.js        cœur serveur (session, outils, persona, verrou des lancements)
jarvis/lib/jarvis-routes.js routes HTTP
jarvis/lib/routes.js        catalogue automatique des routes de server.js
jarvis/public/js/jarvis.js  client (WebRTC, overlay, fenêtres, sous-titres, réglages)
jarvis/public/jarvis.css    styles de l'overlay
jarvis/scripts/jarvis-desktop.py   contrôle du PC Windows (Python/ctypes + Pillow)
jarvis/docs/JARVIS-ACCES.md inventaire des accès et limites
docs/INSTALL.md             installation manuelle
```

## Dépannage

- **« Jarvis non configuré »** : clé OpenAI absente du coffre et du `.env`.
- **Pas de son / micro** : autoriser le micro dans le navigateur ; Chrome ou Edge recommandés (WebRTC).
- **Le contrôle du PC échoue** : `python --version` (3.x) et `pip install pillow` ; les scripts PowerShell équivalents sont bloqués par Defender, c'est voulu.
- **La boîte Telegram reste vide** : le long-poll de `lib/telegram.js` doit stocker les messages texte du chat configuré (`inbox()`), et un seul processus doit consommer `getUpdates` pour ce bot.
