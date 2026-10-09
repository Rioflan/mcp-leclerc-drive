# Leclerc Drive — alertes de réapprovisionnement

Pile Docker auto-hébergée autour du serveur MCP de ce dépôt ([mcp-leclerc-drive](../README.md)), compilé depuis `src/` :

- **Interface web** : panier modifiable (quantités, retrait), onglet des articles en rupture, recherche de produits avec ajout au panier, favoris (produits habituels et listes du compte), Nutri-Score, alertes en un clic et page de gestion des alertes.
- **Notifications [ntfy](https://ntfy.sh)** sur le téléphone ou le bureau quand un produit surveillé redevient disponible. Aucune IA dans la boucle : aucun token consommé.
- **Vérification périodique** à intervalle configurable, avec un délai aléatoire en plus.
- **Serveur MCP** pour Claude Code / Claude Desktop, sur le même navigateur connecté, compilé depuis la source du dépôt.
- **CLI** `scripts/ruptures.sh` qui liste les articles du panier en rupture (texte ou JSON).

> Projet non officiel, sans lien avec E.Leclerc. Leclerc Drive n'a pas d'API publique : tout passe par les endpoints internes du site, rétro-conçus par ce projet (voir [docs/api-capture.md](../docs/api-capture.md)). Ça peut cesser de marcher à tout moment, et ce n'est probablement pas conforme aux CGU du site. À utiliser avec son propre compte, pour un usage personnel.

## Architecture

```
                 127.0.0.1:6080 (noVNC)        127.0.0.1:8080 (interface)
                        │                              │
┌───────────────────────▼──────────┐      ┌────────────▼──────────────┐
│ browser  (container leclerc-drive)│      │ web                        │
│  Xvfb + Chrome (session Leclerc)  │◄─────┤  UI + API (mot de passe)   │
│  bridge HTTP :8000                │ jeton│  planificateur + ntfy      │
│  mcp-leclerc-drive (docker exec)  │      │  /data/alerts.json         │
└───────────────┬──────────────────┘      └────────────┬──────────────┘
                │      réseau « internal » (sans Internet, sans hôte)
                ▼                                      ▼
          leclercdrive.fr                       ntfy.sh ou ntfy local
```

- **browser** : Chrome tourne dans un écran virtuel, avec le profil persistant dans un volume. On s'y connecte une fois à Leclerc Drive via noVNC. Le site est protégé par DataDome, qui bloque les clients automatisés : toutes les requêtes passent donc par ce vrai navigateur.
  - Le **bridge** expose des lectures (panier, recherche, disponibilité, produits habituels, listes, magasin) et une seule écriture : la quantité d'une ligne du panier. Jamais de commande, de créneau ni de paiement. `CART_WRITE=false` le remet en lecture seule.
  - Il travaille dans **son propre onglet**, sans jamais toucher à votre onglet VNC ni à celui du MCP.
- **web** : interface et API sans framework ni dépendance npm à l'exécution, dans une image distroless. Le planificateur interroge le bridge uniquement s'il y a des alertes actives.
- **ntfy** (optionnel, profil `selfhosted-ntfy`) : votre propre serveur de notifications, avec authentification obligatoire.

## Prérequis

- Docker Engine 24 ou plus récent, avec Docker Compose v2.
- Une machine **x86_64** : Google Chrome n'existe pas pour Linux ARM.
- Un compte Leclerc Drive.
- L'application ntfy ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy), [iOS](https://apps.apple.com/app/ntfy/id1625396347)) ou un navigateur sur https://ntfy.sh.

## Serveur MCP seul (sans interface ni alertes)

Pour utiliser uniquement le MCP avec Claude, isolé dans un conteneur, sans
Chrome sur la machine et sans secret à configurer :

```bash
git clone <url-de-votre-fork> mcp-leclerc-drive && cd mcp-leclerc-drive/deploy
docker compose -f compose.mcp.yaml up -d --build
claude mcp add leclerc-drive -- docker exec -i leclerc-drive mcp-leclerc-drive
```

1. Se connecter à Leclerc Drive dans le VNC (http://127.0.0.1:6080/vnc.html, mot de passe : `docker exec leclerc-drive cat /data/.vnc/password.txt`) et ouvrir son drive.
2. Dans Claude : « détecte mon magasin » (outil `detect_store`), puis par exemple « qu'est-ce qu'il y a dans mon panier ? ».

Ce mode reprend le même durcissement : noVNC uniquement sur `127.0.0.1`, port CDP non publié, conteneur non-root en lecture seule. Le bridge HTTP n'est pas démarré. Il utilise le même projet et le même volume que la stack complète : pour y passer plus tard sans se reconnecter, `docker compose -f compose.mcp.yaml down`, puis suivre l'installation ci-dessous.

## MCP sur une machine distante (LAN, VPN)

Le serveur MCP parle en stdio. Pour l'utiliser depuis le Claude d'une autre
machine, il suffit de faire passer ce flux par **SSH** : pas de port
supplémentaire à ouvrir, et c'est SSH qui gère l'authentification et le
chiffrement. Sur le serveur, la stack (complète ou `compose.mcp.yaml`) tourne
normalement.

**1. Sur le client, une clé dédiée sans phrase de passe** (Claude lance la commande sans terminal, il ne peut donc rien saisir) :

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/leclerc_mcp -C leclerc-mcp
```

**2. Sur le serveur, restreindre cette clé à la seule commande MCP**, dans le `~/.ssh/authorized_keys` d'un utilisateur qui peut lancer `docker` :

```
command="docker exec -i leclerc-drive mcp-leclerc-drive",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA… leclerc-mcp
```

Avec `command=`, la clé ne peut rien faire d'autre que lancer le MCP, même si
elle fuit : pas de shell, pas de tunnel, pas d'autre commande. C'est
important, car appartenir au groupe `docker` équivaut à être root sur le serveur.

**3. Sur le client, déclarer le serveur dans Claude :**

```bash
claude mcp add leclerc-drive -- ssh -i ~/.ssh/leclerc_mcp -o BatchMode=yes -T utilisateur@serveur
```

ou, dans la configuration de Claude Desktop :

```json
{
  "mcpServers": {
    "leclerc-drive": {
      "command": "ssh",
      "args": ["-i", "/home/vous/.ssh/leclerc_mcp", "-o", "BatchMode=yes", "-T", "utilisateur@serveur"]
    }
  }
}
```

(Chemin absolu : la configuration JSON ne passe pas par un shell, `~` n'y est pas développé.)

Avant la première utilisation, connectez-vous une fois à la main pour accepter
l'empreinte du serveur (`ssh -i ~/.ssh/leclerc_mcp utilisateur@serveur`, qui
lance le MCP : quittez avec Ctrl+C). Sinon, `BatchMode` refusera l'hôte
inconnu.

**4. Se connecter à Leclerc Drive** sur le Chrome du serveur, depuis le client, avec un tunnel vers noVNC (une autre clé, ou votre clé habituelle, car celle du MCP n'autorise pas les tunnels) :

```bash
ssh -L 6080:127.0.0.1:6080 utilisateur@serveur
# puis http://127.0.0.1:6080/vnc.html sur le client
```

noVNC et le port CDP de Chrome restent ainsi sur `127.0.0.1` côté serveur :
rien n'est exposé sur le réseau. Le MCP **peut modifier le panier** : ne donnez
la clé qu'aux machines de confiance.

## Installation (stack complète)

```bash
git clone <url-de-votre-fork> mcp-leclerc-drive && cd mcp-leclerc-drive/deploy
cp .env.example .env && chmod 600 .env
```

Toutes les commandes qui suivent se lancent depuis `deploy/`. Remplir les trois secrets obligatoires de `.env` :

```bash
# 1. Jeton partagé entre les deux conteneurs
sed -i "s|^BRIDGE_TOKEN=.*|BRIDGE_TOKEN=$(openssl rand -hex 32)|" .env

# 2. Sujet ntfy long et aléatoire (sur ntfy.sh, le connaître suffit pour lire les notifications)
sed -i "s|^NTFY_TOPIC=.*|NTFY_TOPIC=drive-$(openssl rand -hex 12)|" .env

# 3. Mot de passe de l'interface (12 caractères minimum) : saisie masquée, seul le hash est stocké
docker build -t leclerc-drive-web:local web
printf "Mot de passe de l'interface : "; read -rs PW; echo
HASH=$(printf '%s' "$PW" | docker run --rm -i leclerc-drive-web:local src/hash-password.mjs) \
  && sed -i "s|^UI_PASSWORD_HASH=.*|UI_PASSWORD_HASH=$HASH|" .env; unset PW
```

Compose refuse de démarrer tant qu'un secret obligatoire est vide : c'est pour ça que le hash est calculé avec `docker build` / `docker run`, sans passer par compose.

Puis lancer la stack :

```bash
docker compose up -d --build
docker compose ps        # les deux services doivent passer « healthy »
```

### Premier lancement

1. **Se connecter à Leclerc Drive dans le navigateur du conteneur** :
   - ouvrir http://127.0.0.1:6080/vnc.html et cliquer sur *Connect* ;
   - mot de passe VNC : `docker exec leclerc-drive cat /data/.vnc/password.txt` ;
   - dans Chrome, se connecter à son compte et ouvrir **son drive** (l'URL doit contenir `/magasin-…`). La session est conservée dans le volume `browser-data`.
2. **Ouvrir l'interface** : http://127.0.0.1:8080, puis se connecter avec le mot de passe choisi.
3. **Magasin** : il est détecté automatiquement depuis l'onglet du VNC. Si besoin, *Réglages → Détecter mon magasin*. Les points de retrait, dont les deux identifiants diffèrent, sont pris en charge.
4. **Notifications** : dans l'application ntfy, s'abonner au sujet `NTFY_TOPIC` (serveur `https://ntfy.sh`), puis *Réglages → Envoyer une notification de test*.

## Utilisation

| Onglet | Rôle |
| --- | --- |
| **Panier** | Contenu du panier, avec la disponibilité et le Nutri-Score de chaque article. Boutons **−** / **+** par ligne ; à 0, l'article est retiré. Les clics rapprochés sont regroupés en un seul envoi. |
| **Ruptures** | Articles du panier en rupture, avec un bouton **M'alerter**. |
| **Recherche** | Recherche dans le catalogue du magasin : **Ajouter** au panier, ou **M'alerter** sur tout produit en rupture, même hors panier. |
| **Favoris** | « Mes produits habituels » et chaque liste du compte (une liste nommée « Favoris » est ouverte par défaut), avec filtre, ajout au panier et alertes. |
| **Alertes** | Alertes actives et notifiées : date de la dernière vérification, **Réarmer**, **Supprimer**, **Vérifier maintenant** (au plus une fois toutes les 2 minutes). |
| **Réglages** | Magasin, fréquence, dernière erreur, test de notification. |

**Fonctionnement d'une alerte :**
- À chaque vérification, le panier est lu une fois. Les produits hors panier sont retrouvés par une recherche, avec le texte saisi au moment de créer l'alerte.
- Dès qu'un produit est disponible, une notification part et l'alerte passe à l'état **notifiée** : une alerte ne sert qu'une fois, et elle peut être réarmée.
- Si la notification échoue, l'alerte reste active et la notification est retentée au passage suivant.

**En cas de panne :** après `FAILURE_THRESHOLD` vérifications ratées d'affilée (session expirée, blocage anti-bot, navigateur arrêté), **une seule** notification d'alerte part. Une autre suit quand tout est rétabli. Si la session a expiré, il suffit de se reconnecter dans le VNC.

## Configuration

Toutes les variables sont documentées dans [`.env.example`](.env.example). Les principales :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `CHECK_INTERVAL` | `30m` | Intervalle entre deux vérifications (minimum `10m`, pour ménager l'anti-bot du site). |
| `CHECK_JITTER` | `10m` | Délai aléatoire ajouté, entre 0 et cette valeur. Avec les défauts, une vérification a lieu toutes les 30 à 40 min. |
| `FAILURE_THRESHOLD` | `3` | Échecs d'affilée avant une notification d'alerte. |
| `NTFY_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` | `https://ntfy.sh` / — / — | Destination des notifications. |
| `NTFY_PRIORITY` | `4` | Priorité des notifications de disponibilité (1 à 5). |
| `NOTIFY_CART_OUT_OF_STOCK` | `false` | Notifier aussi les nouvelles ruptures dans le panier. |
| `CART_WRITE` | `true` | Autoriser l'interface à modifier le panier. `false` : interface en lecture seule, refus aussi côté bridge. |
| `PUBLIC_URL` | — | URL de l'interface, ajoutée comme lien aux notifications. |
| `SESSION_TTL` | `7d` | Durée d'une session de l'interface. |
| `WEB_PORT` / `VNC_PORT` | `8080` / `6080` | Ports publiés, sur 127.0.0.1 uniquement. |
| `LECLERC_STORE_ID` / `LECLERC_STORE_NOPR` / `LECLERC_HOST` | — | Fixer le magasin au lieu de le détecter. |

Les durées s'écrivent `90s`, `30m`, `1h`, `1h30m`. Une configuration invalide empêche le service web de démarrer, avec un message explicite (`docker compose logs web`).

## ntfy auto-hébergé (optionnel)

Pour ne rien faire transiter par ntfy.sh :

```bash
# .env : NTFY_URL=http://ntfy:8080  et  NTFY_PUBLIC_URL=<URL à laquelle le téléphone joint le serveur>
docker compose --profile selfhosted-ntfy up -d

# Utilisateur qui ne peut qu'écrire dans les sujets drive-*, puis son jeton → NTFY_TOKEN dans .env
docker compose exec ntfy ntfy user add drive
docker compose exec ntfy ntfy access drive 'drive-*' write-only
docker compose exec ntfy ntfy token add drive
docker compose up -d web
```

- Le serveur refuse tout accès anonyme (`deny-all`).
- Pour que l'application mobile le joigne, il faut l'exposer, idéalement derrière un reverse proxy HTTPS (`NTFY_BIND`, `NTFY_PORT`, `NTFY_BEHIND_PROXY=true`).
- Créez un second utilisateur en lecture seule pour le téléphone.
- Sur iOS, les notifications instantanées passent par ntfy.sh (voir `upstream-base-url` dans la [documentation ntfy](https://docs.ntfy.sh/config/#ios-instant-notifications)).

## Accès à distance

L'interface et noVNC n'écoutent que sur `127.0.0.1`. Pour y accéder depuis une autre machine :

- **Tunnel SSH**, le plus simple et sans rien exposer : `ssh -L 8080:127.0.0.1:8080 -L 6080:127.0.0.1:6080 serveur`.
- **Reverse proxy HTTPS** (Caddy, Traefik, nginx) devant `127.0.0.1:8080`. Il faut alors définir `UI_SECURE_COOKIE=true`, `TRUST_PROXY=true` (pour que la limitation des tentatives de connexion vise la vraie IP du client) et `PUBLIC_URL`. Exemple Caddy :

  ```
  drive.exemple.fr {
      reverse_proxy 127.0.0.1:8080
  }
  ```

  N'exposez jamais noVNC sans authentification supplémentaire : il donne la main sur la session Leclerc.

## Serveur MCP (Claude Code)

Le conteneur navigateur garde le nom `leclerc-drive`, pour que le MCP s'y branche directement, que ce soit avec la stack complète ou en [mode MCP seul](#serveur-mcp-seul-sans-interface-ni-alertes). Pour un Claude installé sur une autre machine, voir [MCP sur une machine distante](#mcp-sur-une-machine-distante-lan-vpn). En local :

```bash
claude mcp add leclerc-drive -- docker exec -i leclerc-drive mcp-leclerc-drive
```

Le MCP réutilise le Chrome connecté et le magasin détecté (outil `detect_store`). `get_cart` signale les articles en rupture, `get_usual_products`, `get_lists` et `get_list` donnent les produits habituels et les listes (dont une liste « Favoris »), et le Nutri-Score figure dans toutes les listes de produits. Il peut aussi **modifier le panier** (ajout, retrait, quantités), indépendamment de `CART_WRITE`, qui ne concerne que l'interface.

Pour ne pas valider chaque lecture, autorisez les outils en lecture seule dans `~/.claude/settings.json` (les modifications du panier continueront de demander confirmation) :

```json
{
  "permissions": {
    "allow": [
      "mcp__leclerc-drive__get_cart",
      "mcp__leclerc-drive__search_product",
      "mcp__leclerc-drive__get_usual_products",
      "mcp__leclerc-drive__get_lists",
      "mcp__leclerc-drive__get_list",
      "mcp__leclerc-drive__get_store",
      "mcp__leclerc-drive__find_stores",
      "mcp__leclerc-drive__detect_store"
    ]
  }
}
``` Le conteneur exécute la version de `src/` du dépôt : après une modification du MCP, `docker compose up -d --build browser`.

## CLI

```bash
scripts/ruptures.sh          # liste lisible
scripts/ruptures.sh --json   # JSON, ex. : scripts/ruptures.sh --json | jq '.outOfStock | length'
```

## Sécurité

- **Isolation** : aucun port n'est publié en dehors de `127.0.0.1`. Le bridge (8000) et le port de débogage de Chrome (9222) ne sont pas publiés du tout : le bridge n'est joignable que par le réseau interne, et Chrome uniquement en loopback dans son conteneur.
- **Durcissement des conteneurs** : utilisateurs non-root, `read_only`, `cap_drop: ALL`, `no-new-privileges`, limites de mémoire et de processus, rotation des logs. Le web tourne en distroless.
- **Interface** :
  - mot de passe hashé avec scrypt ;
  - session côté serveur dans un cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` derrière HTTPS) ;
  - jeton CSRF sur toute requête qui modifie, et refus des requêtes cross-site ;
  - au-delà de 5 échecs de connexion en 15 min, nouvelles tentatives refusées jusqu'à la fin de la fenêtre ;
  - CSP stricte sans script ni style en ligne ; contenus du site insérés uniquement en texte.
- **Bridge** : jeton partagé comparé en temps constant, taille des requêtes bornée. Seule écriture : la quantité d'une ligne du panier (entier de 0 à 99), refusée par le bridge lui-même si `CART_WRITE=false`, même si le conteneur web était compromis. Aucune route de commande, de créneau ou de paiement.
- **Chaîne d'approvisionnement** :
  - images de base épinglées par digest ;
  - serveur MCP compilé depuis la source du dépôt, dépendances verrouillées par le `package-lock.json` racine et installées avec `npm ci --ignore-scripts` ;
  - Dependabot pour les images, les actions et les dépendances npm.
- **Limite connue** : Chrome tourne avec `--no-sandbox`, car son sandbox interne a besoin de user namespaces que le profil seccomp par défaut de Docker interdit. C'est le conteneur durci qui sert d'isolation ; ce Chrome ne visite que Leclerc Drive.
- **Secrets** : uniquement dans `.env`, ignoré par git. Le sujet ntfy est masqué dans l'interface.

## Exploitation

```bash
docker compose logs -f web              # vérifications, erreurs
git pull && docker compose up -d --build   # mise à jour
```

- **Données** : volume `browser-data` (profil Chrome, session Leclerc, magasin) et volume `web-data` (`alerts.json`). Pour sauvegarder : `docker run --rm -v leclerc-drive_web-data:/d:ro -v "$PWD":/b alpine tar czf /b/web-data.tgz -C /d .` (le projet compose s'appelle toujours `leclerc-drive`).
- **Mise à jour d'un digest** : `docker buildx imagetools inspect node:22-bookworm-slim`, puis reporter le digest dans les Dockerfiles. Dependabot propose ces mises à jour automatiquement.
- **Dépannage** :
  - *Session Leclerc Drive expirée* : se reconnecter dans le VNC.
  - *Aucun magasin configuré* : ouvrir son drive dans le VNC, puis *Réglages → Détecter mon magasin*.
  - *Bloqué (anti-bot)* : attendre, puis recharger la page du drive une fois dans le VNC. Évitez de baisser `CHECK_INTERVAL`.
  - *Le service web ne démarre pas* : `docker compose logs web` liste les variables invalides.

## Développement

```bash
cd deploy/web && npm test     # tests unitaires et HTTP (node:test, sans dépendance)
npm run typecheck             # à la racine : serveur MCP
```

La CI (GitHub Actions, `.github/workflows/ci.yml`) vérifie les types et compile le MCP, exécute les tests du service web, ShellCheck, Hadolint, valide le compose et construit les deux images.

```
src/              serveur MCP (TypeScript) — compilé dans l'image navigateur
deploy/
  compose.yaml    stack complète          compose.mcp.yaml   MCP seul
  .env.example
  browser/        Dockerfile (contexte : racine du dépôt), entrypoint.sh, src/{leclerc,bridge,ruptures,healthcheck}.mjs
  web/            Dockerfile, src/ (serveur, auth, planificateur, ntfy…), public/ (interface), test/
  scripts/        ruptures.sh
```

## Licence

[MIT](../LICENSE), comme le reste du dépôt.
