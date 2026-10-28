# Jarvis — inventaire des accès

État au 2026-10-27. Jarvis dispose de 47 outils. Trois niveaux d'accès se complètent :

1. **Outils dédiés** — une action métier en un appel (fiables, rapides).
2. **Accès universel à l'API** — `api_routes` cherche dans les 308 routes de `server.js` (catalogue
   extrait automatiquement du code, donc toujours à jour, avec les paramètres de chaque route :
   `?q` pour la requête, `{type, item}` pour le corps), `agentos_api` appelle la route.
3. **Accès par l'interface** — `open_page` ouvre n'importe quelle page dans une fenêtre de
   l'appel ; `page_read` lit ce qui est affiché (texte + éléments numérotés) ; `page_act` clique,
   remplit un champ, choisit dans une liste, coche. Tout bouton de toute page est donc atteignable.

## Où il vit

Jarvis est l'**overlay plein écran** (`public/js/jarvis.js`, mode `full` ; `RÉDUIRE` / Échap = widget
réduit en bas à droite). Une tentative de « bulle permanente sur le site » (2026-10-27) a été rejetée par
Alex le jour même et retirée : il veut l'écran complet. Alex travaille depuis l'appel, dans des fenêtres
embarquées ; Jarvis ne navigue pas le site derrière l'overlay.

**Gardien d'Agentic OS, rien d'autre** : la persona lui interdit toute invention (sujet, idée, paramètre,
chiffre, fonctionnalité) ; quand Alex nomme quelque chose qu'il ne rattache pas avec certitude à un outil,
il consulte `platform_lookup` (lexique de la plateforme : pages, machines, outils, routes, synonymes
d'Alex comme « niche musique », « le scrap », « la banque ») puis pose une question. Les idées viennent
uniquement de `machine_idea` (qui choisit désormais le style/personnage par défaut et dit sur quoi il
s'appuie) et sont rapportées telles quelles.

Voix : `cedar` par défaut (ou `marin`), les deux voix de nouvelle génération de l'API Realtime ; la
consigne de ton (`VOICE_STYLE` dans `lib/jarvis.js`) est injectée dans la persona et dans l'aperçu
`GET /api/jarvis/voice-preview?voice=` (bouton « ▶ Écouter » des réglages, TTS `gpt-4o-mini-tts`).

Ordre de recours imposé dans sa persona : 1 → 2 → 3 → `ask_claude` / `web_search` / `computer_*`.
Il lui est interdit de répondre « je ne peux pas » sans avoir essayé 2 et 3.

## Ce à quoi il a accès

### Machines (8 : Time Travel, Linguistique, Musique, Story Family, Stickman, POV, Wealth, Data Ranking)
| Action | Outil |
|---|---|
| Fiche : liste structurée des paramètres (clé, type, bornes, défaut, requis), réglages, choix disponibles (personnages, styles, avatars, familles, voix) | `machine_info` |
| Trouver une ou plusieurs idées | `machine_idea` |
| Lancer une création, **accompagnée et verrouillée** : 1er appel → plan (`planId`, sujet, réglages résolus, devis, `missing`) et rien n'est lancé ; Jarvis demande le sujet (ou `pickIdea:true`), propose les réglages, ajuste (`planId` + `params`), récapitule et demande « on lance ? » ; lancement seulement avec `confirm:true` + `planId` (plan de moins de 15 min) — le serveur refuse tout lancement sans plan préalable | `machine_run` |
| Runs récents, stock (vidéos finies, publiées ou non), état d'un run | `machine_runs` list / stock / status |
| Valider une étape, annuler, reprendre | `machine_runs` validate / cancel / resume |
| Modifier les réglages permanents | `machine_settings` |
| Ouvrir la machine, directement sur un run | `open_page` (+ `run=<id>`) |
| Tout le reste (créer/régénérer un personnage, avatar, style, famille ; régénérer une scène ; miniature ; textes SEO ; publier sur YouTube ; envoi VPS POV) | `api_routes` + `agentos_api`, ou `page_act` dans la fenêtre |

### Banque de niches, veille, scraping
| Action | Outil |
|---|---|
| Niche d'une machine : chaînes concurrentes, abonnés, top vidéos, tags | `niche_bank {machine}` |
| Détail d'une chaîne concurrente (ses vidéos) | `niche_bank {machine, channel}` |
| Liste des niches | `niche_bank` |
| **Dernières vidéos des concurrents** d'une machine ou d'une niche (par date), avec mise à jour automatique des fiches de plus de 24 h | `competitor_videos {machine}` |
| Créer une niche, ajouter/retirer une chaîne | `agentos_api` (`/api/bank/…`) |
| Scrap-o-matic : ajouter une chaîne/vidéo, lancer un scraping, analyser, lire transcript et vision | `agentos_api` (`/api/scrap/…`) |
| Niche Finder : recherche d'outliers, historique, quota | `agentos_api` (`/api/niche/…`) |
| Labo de niche : scan, digest chiffré | `agentos_api` (`/api/lab/…`) |

### Chaînes YouTube, stats, calendrier, tâches
| Action | Outil |
|---|---|
| Vue d'ensemble (santé, chaînes, tâches, événements) | `platform_overview` |
| **Rapport d'une chaîne** (ou de toutes) : vues et abonnés nets de la période (jour par jour, à jour), meilleure journée, compteurs actuels, stock privé, dernière vidéo (date, confidentialité, vues, likes), vidéos récentes les plus vues — fenêtre affichée toute seule | `channel_stats {channel, period, refresh}` |
| Stats (séries par période, temps réel), dépenses par API/machine | `agentos_api` (`/api/stats/series`, `/api/stats/live`, `/api/spend`) |
| Chaînes : aperçu, association à une machine, restock | `agentos_api` (`/api/channels/…`) |
| Calendrier de publication : plans, événements | `agentos_api` (`/api/schedule/…`) |
| Tâches, crons Telegram, crons Hermès | `agentos_api` (`/api/tasks`, `/api/crons`, `/api/hermes/crons`) |

### Génération de médias
| Action | Outil |
|---|---|
| Image rapide (Miniature Creator) | `generate_image` |
| N'importe quel modèle Kie (218 : vidéo, image, musique, voix) | `kie_catalog` → `kie_schema` → `kie_generate` |
| Retrouver un fichier généré, le réutiliser comme source | `recent_files` |
| Le média s'affiche tout seul dans une fenêtre à l'arrivée | automatique |

### Connaissance et agents
| Action | Outil |
|---|---|
| Second cerveau : chercher, lire, écrire une note, interroger le graphe | `brain_search` / `brain_read` / `brain_write` / `brain_graph` |
| Internet | `web_search` |
| Claude Code (code, fichiers, analyses longues) | `ask_claude` |
| Hermès | `ask_hermes` |
| Mémoire durable, programme du jour | `remember` / `forget` / `program_*` |

### Ordinateur et Telegram
| Action | Outil |
|---|---|
| Ouvrir une application, un dossier, une URL ; Telegram | `computer_open` |
| Fenêtres Windows : lister, mettre devant, réduire, agrandir, fermer | `computer_windows` |
| Voir l'écran (capture + description) | `computer_screenshot` |
| Clavier, raccourcis, clics | `computer_type` / `computer_keys` / `computer_click` |
| Commande PowerShell, lire un fichier ou un dossier | `computer_run` / `read_file` / `list_dir` |
| Telegram : texte et fichiers (image, vidéo, audio) | `notify_telegram` |

### Fenêtres de l'appel
`show_window` (tableaux, chiffres, listes, images, vidéos, audio, liens), `open_page`, `page_read`,
`page_act`, `window_control` (ranger, agrandir, remettre), `close_window`. Lexique : `platform_lookup`.

## Suivi : il prévient sans être relancé

- **Ce qu'il lance lui-même** (image, vidéo Kie, Claude Code, Hermès, veille concurrents) tourne en
  job : le résultat est poussé au navigateur (SSE `job_done`) et Jarvis l'annonce dès réception.
- **Les tâches de la plateforme** pendant l'appel (run terminé, run en attente de validation,
  publication, échec) : `lib/tasks.js` prévient `lib/jarvis.js` (`tasks.onEvent`), qui pousse un
  événement `task_event` ; Jarvis l'annonce en une phrase (`[SUIVI]`).
- **Veille concurrents** : `competitor_videos` répond tout de suite avec ce qui est en banque, lance
  le rescraping des fiches périmées (3 chaînes de front, une relance par chaîne, 0,025 $ par chaîne),
  puis le tableau se met à jour et Jarvis fait le compte-rendu. Sans précision, la niche est celle de
  la machine ouverte au premier plan.
- Un rescraping **fusionne** avec la fiche existante (`scrap.scrapeChannel`) : il ajoute les nouvelles
  vidéos et met à jour les chiffres, sans jamais effacer l'historique déjà en banque.

Limite : le suivi n'existe que pendant l'appel. Appel fermé, restent les alertes Telegram.

## Ce à quoi il n'a pas accès (limites réelles)

| Limite | Pourquoi |
|---|---|
| Impressions, CTR des miniatures, durée de visionnage | L'API YouTube Analytics refuse impressions et CTR (`Unknown identifier (impressions)`, vérifié le 2026-10-27) : réservés à YouTube Studio. Le rapport de chaîne s'appuie donc sur les compteurs (vues, abonnés, likes) et pas sur l'Analytics. |
| Lire une clé du coffre en clair | Par conception : l'API ne renvoie que des aperçus masqués. Il peut en écrire une. |
| Connecter Google Drive ou une chaîne YouTube | L'écran de consentement Google doit être validé par Alex. |
| Envoyer un fichier depuis le disque via un bouton « Disque… » | Un navigateur interdit à un script de choisir un fichier local. Il passe par Mes fichiers ou par un chemin. |
| Regarder une vidéo ou écouter un audio | Il ne voit que des images (capture d'écran) et lit les textes, transcripts et analyses déjà produits. |
| Changer de voix ou de modèle pendant l'appel | Limite de l'API OpenAI : effectif à la prochaine activation (désactiver puis réactiver). |
| Se souvenir d'un appel à l'autre | Voulu : chaque appel repart de zéro. Restent `remember` et le programme du jour. |
| Agir quand l'appel est fermé | Il n'a pas de tâche de fond. Pour du planifié : crons Hermès ou calendrier. |
| Sites externes où Alex est connecté (YouTube Studio, etc.) | Seulement par le contrôle du PC (capture + clics) : lent et fragile. |
| Redémarrer le serveur, modifier le code | Uniquement via `ask_claude` ; un redémarrage interrompt les runs en cours. |
| Fichier Telegram de plus de 50 Mo | Limite de l'API des bots Telegram. |
| Plus de 110 éléments manipulables par page | `page_read` tronque la liste ; il faut filtrer ou naviguer. |

## Ce qui est vérifié, ce qui ne l'est pas

Vérifié en conditions réelles : génération Kie image puis vidéo, envoi Telegram d'une image, lecture
de la Banque et clic sur une chaîne, remplissage du champ sujet et changement d'onglet dans la
machine POV, stock de quatre machines, recherche dans le catalogue de routes, contrôle du PC
(capture, ouverture d'application).

Veille concurrents vérifiée de bout en bout sur la niche Data Ranking : 5 chaînes rescrappées en
36 s pour 0,125 $, 8 nouvelles vidéos ajoutées, aucune vidéo existante perdue, tableau affiché,
résultat poussé au navigateur ; puis, en mode texte, le modèle annonce de lui-même le résultat et
un run en attente de validation.

Vérifié à blanc seulement (corps de requête construit, aucun run créé) : `machine_run` sur les huit
machines.

Vérifié sur le choix d'outil uniquement (modèle `gpt-realtime-2.1-mini` en mode texte, lectures
réelles, écritures simulées) : ouvrir une machine, chaînes concurrentes d'une machine, stock,
dépenses, chaînes et abonnés, calendrier de publication, ajout et scraping d'une chaîne, miniature
d'un run, création d'un personnage Stickman, recherche Niche Finder, lancement d'un run, réglage
d'une machine, fichiers récents. Dans ces tests, le modèle appelle la bonne route ; l'effet réel de
la route n'a pas été déclenché.

Non exécuté pour de vrai : les routes d'écriture appelées par `agentos_api` (publication YouTube,
scraping, création de personnage, recherche Niche Finder, calendrier). L'accès existe, mais chaque
appel engage un coût, du quota ou une action publique.

Non testé : un appel vocal complet en mode WebSocket avec micro et haut-parleurs réels.

Fiabilité : avec `gpt-realtime-2.1-mini`, les enchaînements longs échouent plus souvent qu'avec
`gpt-realtime-2.1` (réglage Modèle dans Paramètres). Le modèle peut aussi se tromper sur la forme
d'un corps de requête : la route répond alors par une erreur 400 qui dit ce qui manque, et il
réessaie.
