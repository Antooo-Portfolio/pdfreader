# Architecture : PDFReader (nom de code), une reconstruction des fonctions d'Adobe Acrobat Reader

Phase 1 « Lecteur » : écrans S01–S15 de `recon.md`.
Le nom définitif viendra de `/replica-brand`.
Date : 2026-11-09. Révisions du même jour : application gratuite, code fermé, puis
**desktop uniquement, installée par un fichier setup**.

## Le principe qui guide tout

**Une application de bureau, entièrement locale, gratuite et accessible à tous** :
- **locale** : elle s'installe sur l'ordinateur et tout se passe dessus. Il n'y a **pas de
  version navigateur**, pas de serveur, pas de compte. Le fichier ne quitte jamais la machine ;
- **installée par un fichier setup** : on télécharge `PDFReader-Setup-x.y.z.exe`, on
  double-clique, c'est installé. Pas de Store obligatoire ;
- **gratuite** : pas d'abonnement, pas de licence à activer, pas de clé, pas d'outils
  verrouillés, pas de publicité. Les outils que vend Acrobat (organiser, combiner, compresser,
  protéger, OCR…) seront gratuits aussi, phase après phase ;
- **zéro coût pour l'éditeur aussi** : aucun service payant, aucun certificat acheté, aucun
  nom de domaine obligatoire. Tout ce qui est choisi ici est gratuit ;
- **code fermé** : le code source n'est pas publié. Chaque dépendance doit donc autoriser l'usage
  dans un logiciel propriétaire (voir « Licences tierces ») ;
- **accessible** : visée WCAG 2.2 AA dès la phase 1 (lecteurs d'écran, clavier complet,
  contraste élevé, zoom de l'interface, lecture à voix haute), interface en français et en anglais.

**Réseau** : aucun appel par défaut. La seule exception possible est la vérification des mises à
jour. Elle est proposée au premier lancement, désactivée tant que l'utilisateur ne l'a pas
acceptée, et disponible à tout moment par « Rechercher des mises à jour ». Aucune télémétrie.

```
┌──────────────────────────── apps/desktop (Tauri 2) ────────────────────────────┐
│                                                                                │
│  Interface (WebView2 sur Windows)            Cœur natif (Rust)                 │
│  packages/viewer + packages/ui (React)       crates/engine : PDFium natif      │
│  S01–S15, composants, i18n, a11y     ◄─────► (pdfium-render) dans un thread    │
│  état d'affichage (Zustand)          IPC     dédié : rendu en tuiles, texte,   │
│                                    + pdf://  recherche, annotations, champs,   │
│                                              sauvegarde incrémentale           │
│                                              crates/app : fichiers, SQLite,    │
│                                              instance unique, impression       │
└──────────────────────────────────────▲─────────────────────────────────────────┘
                                       │ (facultatif, si l'utilisateur l'accepte)
        latest.json + setup sur GitHub Releases (dépôt public de versions, gratuit)
```

### Ce qui change par rapport à la version précédente

L'interface navigateur disparaît. La seule raison de faire tourner PDFium en WebAssembly était de
partager le moteur avec le web : **le moteur passe donc en natif, côté Rust**. On y gagne :
- les polices système (plus de polices de substitution à embarquer pour les PDF à polices non
  embarquées, seulement un filet de sécurité) ;
- l'accès direct au fichier par blocs, sans protocole à plages ni plafond de 4 Go ;
- l'impression vectorielle native (PDFium vers GDI sur Windows) dès la phase 1 ;
- de meilleures performances.

L'interface reste en React dans la WebView, ce qui conserve le système de design déjà construit.

## Stack

| couche | choix | pourquoi |
| --- | --- | --- |
| dépôt | monorepo : npm workspaces (front) + workspace Cargo (Rust) | un seul dépôt, une seule CI |
| coquille | **Tauri 2** (Rust + WebView2 sur Windows ; WKWebView sur macOS et WebKitGTK sur Linux plus tard) | installeur d'environ 10 Mo (plus la DLL PDFium, environ 6 Mo), peu de mémoire, tourne sur des machines modestes. Plugins officiels : instance unique, dialogues, mises à jour signées, association de fichiers. |
| moteur PDF | **PDFium natif** (BSD-3 / Apache-2.0) via le crate **`pdfium-render`** ; binaire `pdfium.dll` de bblanchon/pdfium-binaries embarqué dans l'installeur | le moteur de Chrome : fidèle, rapide, il écrit les annotations avec leur apparence et sait faire une sauvegarde incrémentale. PDFium n'est pas thread-safe : tous les appels passent par **un thread moteur dédié** et une file de commandes priorisée. Attention à ne pas confondre avec le crate `pdfium` (pdfium-rs), qui est sous GPL et donc exclu. |
| transfert du rendu | tuiles de 512 px rendues par Rust, servies à la WebView par un protocole personnalisé `pdfpage://{doc}/{page}/{scale}/{x}/{y}` en RGBA brut ou WebP sans perte ; texte, recherche et annotations en JSON par l'IPC Tauri | aucun octet du PDF dans la WebView ; seules les tuiles visibles transitent. Latence à valider en M0. |
| interface | React 19 + TypeScript + Vite, paquets `packages/viewer` et `packages/ui` | système de design déjà en place (`replica/design`) |
| styles | Tailwind CSS v4, jetons de `replica/design/tokens.json` | thèmes clair, sombre, contraste élevé, `forced-colors` |
| accessibilité | React Aria Components (Apache-2.0) ; couche de texte DOM pour le contenu PDF ; voix de Windows pour la lecture à voix haute | WCAG 2.2 AA sans tout réinventer |
| état | Zustand (interface) ; le document vit dans le thread moteur Rust | l'interface reste fluide |
| i18n | Lingui (FR + EN au lancement) | catalogues `.po`, pluriels ICU |
| base locale | SQLite (`tauri-plugin-sql` ou `rusqlite` côté Rust), schéma `replica/schema-local.sql` | récents, état de vue, préférences, signature, copies de récupération |
| serveur, base distante, compte, paiement, e-mail | **aucun** | appli gratuite et locale |
| installeur Windows | **NSIS** généré par le bundler Tauri : `PDFReader-Setup-x.y.z.exe`, installation par utilisateur (sans droits administrateur) ou pour tous, désinstalleur dans « Applications installées », association .pdf proposée, contrat de licence (EULA) affiché, WebView2 installée si absente | « un fichier setup », comme demandé |
| signature de code | **aucune** (choix zéro coût). Le setup n'est pas signé Authenticode : Windows SmartScreen affiche « Windows a protégé votre ordinateur » au premier lancement, et l'utilisateur clique « Informations complémentaires » puis « Exécuter quand même ». La page de téléchargement l'explique avec une capture. | un certificat coûte 150 à 500 $/an ; la signature gratuite (SignPath Foundation) est réservée à l'open source. Voir « Les parties qui mordent ». |
| canal sans avertissement (facultatif) | fiche **Microsoft Store**, gratuite pour les développeurs individuels : le Store signe lui-même le paquet MSIX, donc pas d'écran SmartScreen | en plus du setup, pas à la place. Gratuit. À décider. |
| mises à jour | `tauri-plugin-updater` : vérification **sur consentement**, téléchargement du nouveau setup (signature Ed25519 de Tauri vérifiée : c'est gratuit et indépendant de la signature Windows), installation silencieuse, redémarrage | un lecteur PDF lit des fichiers non fiables : les correctifs de sécurité doivent pouvoir arriver |
| hébergement du setup et des mises à jour | **GitHub Releases** du dépôt public `Antooo-Portfolio/pdfreader` (révision du 2026-11-12 : un seul dépôt public, code compris ; licence inchangée) — à l'origine, un dépôt **public qui ne contient que les versions** (`pdfreader-releases` : setup, `latest.json`, notes ; pas le code). Le code reste dans un dépôt privé. | gratuit, sans limite de bande passante pratique, et l'updater de Tauri sait lire une URL de Release. Cloudflare Pages limite les fichiers à 25 Mo, ce qui le rend inadapté au setup. |
| site de téléchargement | **GitHub Pages** du même dépôt public : bouton « Télécharger », marche à suivre face à SmartScreen, notes de version, EULA, politique de confidentialité, licences tierces. Adresse gratuite `<compte>.github.io/pdfreader` ; un nom de domaine (environ 10 €/an) est facultatif. | il faut bien un endroit d'où télécharger le setup. Ce n'est pas une version web de l'app. |
| CI | GitHub Actions sur le dépôt (public depuis le 2026-11-12 ; à l'origine privé) (forfait gratuit : 2 000 minutes par mois, les machines Windows comptent double) ou build local | une build Windows prend environ 10 minutes : le forfait suffit largement |
| erreurs et support | pas de télémétrie ; rapport de plantage écrit **localement**, que l'utilisateur peut joindre à un e-mail de support | vie privée totale |
| tests | `cargo test` (moteur), Vitest (interface), Playwright sur la WebView2 via le pilote WebDriver de Tauri, axe-core (accessibilité), corpus de PDF publics | jamais de comparaison automatisée avec Acrobat (CGU Adobe §17) |
| page de design | `apps/design` : outil de développement qui s'ouvre dans le navigateur pour voir les composants. **Jamais livrée.** | vérification du système de design |

### Arborescence

```
apps/
  desktop/          Tauri 2 : src-tauri (commandes, protocole pdfpage://, plugins, NSIS) + front Vite
  design/           page /design, outil de développement (non livré)
crates/
  engine/           PDFium : thread moteur, rendu en tuiles, texte, recherche, annotations, champs, sauvegarde
  app/              fichiers, SQLite, récupération, impression, préférences
packages/
  viewer/           React : écrans S01–S15, raccourcis, i18n
  ui/               composants (React Aria + Tailwind), jetons générés
corpus/             PDF de test publics + nos propres fichiers (jamais de sorties Acrobat)
```

## Schéma

**Distant** : aucun. **Local** : 5 tables SQLite (`replica/schema-local.sql`) :

| table | rôle |
| --- | --- |
| recent_files | fichiers récents et favoris (S01) |
| view_states | dernière page, zoom, mode d'affichage par document |
| preferences | préférences (S14), exportables en JSON |
| saved_signatures | signature et initiales manuscrites (S12), jamais envoyées nulle part |
| recovery_snapshots | copies de récupération des modifications non enregistrées |

La base se trouve dans `%APPDATA%\PDFReader\` (dossier de données de Tauri). Le désinstalleur
propose de la conserver ou de la supprimer.

**Dans le fichier PDF, pas en base** : Document, Page, Annotation, FormField, Bookmark,
DigitalSignature (modèle de données de `recon.md`). Le moteur les lit et les écrit selon
ISO 32000-2 : un commentaire ajouté chez nous s'affiche dans Acrobat, Chrome ou Preview.

## API

Pas de route serveur, pas de webhook, pas de tâche planifiée. L'« API » est l'IPC entre
l'interface et le cœur Rust.

### Commandes Tauri (Rust)

| commande / événement | fait | parcours |
| --- | --- | --- |
| `get_launch_files()` | chemins reçus en argument (double-clic sur un .pdf, « Ouvrir avec ») | F01 |
| événement `open-files` | deuxième lancement redirigé par `single-instance` vers la fenêtre ouverte | F01 |
| `open_file_dialog()` | dialogue d'ouverture natif, filtre .pdf, sélection multiple | F01 |
| `doc_open(path, password?)` | ouvre dans le moteur et renvoie les infos : pages, tailles, permissions, chiffré, XFA, AcroForm, signets, pièces jointes, calques. Erreurs typées : `password_required`, `wrong_password`, `corrupted`, `unsupported` | F01, F21 |
| protocole `pdfpage://` | sert les tuiles rendues (page, échelle, rotation, zone) ; annule une tuile qui n'est plus visible | F01 |
| `doc_text_layer(doc, page)` | blocs de texte et boîtes de caractères, plus l'ordre de lecture balisé s'il existe | F02, a11y |
| `doc_search(doc, query, opts)` → Channel | résultats page par page en flux, annulable | F02 |
| `doc_annotations(doc, page)` / `annot_add` / `annot_update` / `annot_delete` | lit et modifie les annotations (avec génération des apparences) | F03 |
| `doc_fields(doc)` / `field_set(doc, name, value)` | formulaires AcroForm | F04 |
| `doc_place_signature(doc, page, rect, image)` | appose la signature manuscrite (image + annotation) | F04 |
| `doc_save(doc, path?, mode)` | `incremental` ou `full` ; écriture atomique (temporaire, fsync, renommage) ; refuse si le fichier a changé sur le disque | F05 |
| `save_as_dialog(name)` | dialogue Enregistrer sous | F05 |
| `watch_file(path)` / événement `file-changed` | modification externe détectée | F05 |
| `recovery_snapshot(doc)` | copie de récupération des modifications non enregistrées | F05 |
| `print(doc, options)` | impression **native vectorielle** (PDFium vers GDI) avec la boîte d'impression Windows ou notre S13 | F06 |
| `doc_close(doc)` | libère le document | — |
| `check_updates()` | uniquement si l'utilisateur l'a accepté, ou s'il clique « Rechercher des mises à jour » | S35 |
| `open_default_apps_settings()` | ouvre `ms-settings:defaultapps` (Windows interdit de s'imposer comme lecteur par défaut) | S14 |
| `reveal_in_folder(path)` | afficher dans l'explorateur | S01 |

## Les parties qui mordent

- **Transfert du rendu vers la WebView** : c'est le nouveau point chaud. Tuiles de 512 px, rendues
  à l'échelle de l'écran × `devicePixelRatio`, cache LRU côté Rust (borné en Mo), file de
  priorité (tuiles visibles d'abord), annulation quand on fait défiler. Objectif M0 : moins de
  30 ms par tuile, première page en moins de 300 ms.
- **PDFium n'est pas thread-safe** : un seul thread moteur, toutes les commandes passent par une
  file. Une opération longue (recherche dans 2 000 pages) est découpée et cède la place au rendu
  des pages visibles. Plus tard, pour les traitements lourds (OCR, compression), on utilisera des
  processus séparés.
- **Robustesse face aux PDF malveillants** : PDFium est du C++ qui parse des fichiers non fiables.
  En cas de plantage du moteur, toute l'app tombe. Mesures : PDFium à jour (mise à jour
  hebdomadaire de bblanchon/pdfium-binaries suivie en CI), aucun JavaScript de PDF exécuté en
  phase 1, liens externes confirmés, pièces jointes jamais exécutées. Fait en M3 : moteur dans un
  **processus séparé** et redémarrable (voir le journal, lot « moteur séparé ») ; un PDF piégé
  n'emporte plus l'application, les documents sont rouverts et celui qui récidive est fermé.
- **Gros fichiers** : lecture par blocs (`FPDF_LoadCustomDocument`), jamais tout en mémoire.
  Objectif : un PDF de 2 Go s'ouvre et reste fluide.
- **Machines modestes** : moins de 300 Mo de mémoire en lecture courante, démarrage à froid en
  moins de 1,5 s sur un PC à 4 Go de RAM.
- **Fidélité de la sauvegarde** : incrémentale par défaut, obligatoire si le document est signé.
  Annotations écrites avec leur flux d'apparence. PDF chiffrés réenregistrés avec le même
  chiffrement (à valider en M0).
- **Perte de données** : écriture atomique, copie de récupération toutes les 2 minutes s'il y a des
  modifications, détection de modification externe, fichier verrouillé par une autre application
  → proposer Enregistrer sous.
- **Setup non signé (choix zéro coût)** : c'est le prix de la gratuité totale. Conséquences et
  parades, toutes gratuites :
  - l'écran SmartScreen apparaît au premier lancement de chaque nouveau setup. La page de
    téléchargement montre comment passer outre, et l'installeur garde le même nom d'éditeur et la
    même présentation d'une version à l'autre ;
  - les **mises à jour automatiques ne déclenchent pas cet écran** : SmartScreen ne vérifie que les
    fichiers téléchargés par un navigateur, et l'updater de Tauri télécharge lui-même (à confirmer
    en M1). L'avertissement ne concerne donc en pratique que la première installation ;
  - certains antivirus se méfient des exécutables non signés. Si Microsoft Defender signale le
    setup à tort, on le soumet gratuitement à l'analyse de Microsoft (portail de soumission de
    fichiers, catégorie « développeur de logiciel ») ; idem chez les autres éditeurs d'antivirus.
    Le build doit rester propre : pas de compression d'exécutable (type UPX), pas de
    téléchargement de code au lancement ;
  - la fiche **Microsoft Store** gratuite, facultative, donne une installation sans aucun
    avertissement à ceux qui préfèrent le Store ;
  - l'intégrité des mises à jour reste garantie par la signature Ed25519 de Tauri (gratuite), qui
    est indépendante de la signature Windows ;
  - si un jour le projet devient open source, SignPath Foundation signe gratuitement. Si un jour
    un budget existe, un certificat OV (150 à 500 $/an) supprime l'avertissement au bout de
    quelques semaines de réputation.
- **macOS plus tard** : sans compte Apple Developer (99 $/an), une app non notarisée est bloquée
  par Gatekeeper et l'utilisateur doit l'autoriser dans les Réglages. Avec la contrainte zéro
  coût, macOS reste possible mais pénible pour l'utilisateur. Linux (AppImage / .deb) ne pose aucun
  problème.
- **Mises à jour sans serveur applicatif** : un simple fichier `latest.json` statique sur GitHub
  Releases, signé Ed25519 (clé privée hors du dépôt, dans les secrets de la CI). Si l'utilisateur refuse la
  vérification automatique, l'app ne contacte jamais Internet ; le menu Aide propose « Rechercher
  des mises à jour ».
- **Installation** : par utilisateur par défaut (pas de droits administrateur, mises à jour
  silencieuses possibles) ; installation pour tous en option. WebView2 est présent sur Windows 10
  et 11 à jour, sinon l'installeur le télécharge (ou on embarque la version autonome, environ
  +150 Mo, pour les postes hors ligne : variante « hors ligne » du setup en M3).
- **Association .pdf** : déclarée par l'installeur, case « Ouvrir les PDF avec PDFReader »
  proposée. Windows 10/11 ne permet pas de s'imposer comme lecteur par défaut : il faut guider
  l'utilisateur vers les Paramètres (bouton dans S14).
- **Accessibilité** : couche de texte DOM construite à partir des boîtes de caractères envoyées par
  le moteur (sélection native, copier, NVDA, Narrateur). Ordre de lecture des PDF balisés. Tout
  au clavier, focus visible, zoom de l'interface, `forced-colors`, lecture à voix haute avec les
  voix de Windows (`speechSynthesis` de WebView2). axe-core en CI, plus des tests NVDA à chaque version.
- **Courses** : même fichier ouvert deux fois (instance unique, focus sur l'onglet existant) ;
  sauvegarde pendant une modification externe (contrôle de `mtime`) ; commande moteur sur un
  document déjà fermé (identifiants de document vérifiés et générations).
- **Fuseaux horaires** : les dates d'annotation sont des dates PDF avec décalage
  (`D:20261109183000+01'00'`), affichées dans le fuseau local.
- **Recherche** : dans le thread moteur, page par page, texte extrait mis en cache. Normalisation :
  ligatures, césures, option « ignorer les accents ». Un PDF sans texte affiche un bandeau qui
  prépare l'OCR de la phase 3.
- **Formulaires** : AcroForm pris en charge ; XFA non pris en charge (bandeau). Les calculs
  JavaScript viendront en M3 dans un bac à sable QuickJS avec une API restreinte.
- **Licences tierces (code fermé)** :
  - autorisées : MIT, BSD, Apache-2.0, ISC, Zlib, OFL pour les polices, MPL-2.0 sans modification.
    Cela couvre PDFium, `pdfium-render` (licence à confirmer en M0 par `cargo-deny`), Tauri,
    React, React Aria, Lingui, Zustand, `rusqlite`, et plus tard Tesseract et qpdf ;
  - interdites : GPL, AGPL, LGPL en liaison statique. Donc MuPDF, Ghostscript et le crate `pdfium`
    (pdfium-rs) sont exclus ;
  - en CI : `license-checker` (npm) et `cargo-deny` (Rust) bloquent toute licence hors liste blanche ;
  - dans l'app : écran « Licences tierces » dans À propos, plus le fichier
    `THIRD-PARTY-NOTICES.txt` installé avec l'app.
- **Les phases suivantes restent locales** : compression, protection, organisation, OCR
  (Tesseract natif) se font sur l'ordinateur. La conversion vers et depuis Office reste le point
  dur : LibreOffice embarqué (MPL-2.0, environ +300 Mo, donc en module facultatif) ou un moteur
  maison limité. À trancher avant la phase 3.
- **Coûts : zéro.** Tauri, PDFium, React et les autres briques sont gratuits. L'hébergement
  (GitHub Releases + Pages), la CI (forfait gratuit de GitHub Actions), le Microsoft Store et les
  outils de licence aussi. Aucune dépense n'est nécessaire, ni maintenant ni pour durer. Les seules
  dépenses possibles sont facultatives : un nom de domaine, un certificat de signature, un compte
  Apple.
- **RGPD** : aucune donnée personnelle collectée ni transmise. La vérification des mises à jour
  n'envoie que la version et la plateforme, c'est-à-dire l'adresse IP visible par l'hébergeur ;
  c'est écrit dans la politique de confidentialité.

## Décisions issues du spike M0 (voir `replica/m0-report.md`)

- Tuiles servies en **WebP sans perte** (5,4 ms par tuile 512 px, du rendu jusqu'à l'affichage).
- Copie locale de **pdfium-render** (`vendor/`) : sauvegarde incrémentale et handles bruts.
- **Formulaires** : toute saisie est validée par le moteur interactif de PDFium (`FORM_*`), qui
  régénère l'apparence. Jamais `set_value` seul.
- **Annotations** : apparence générée par un rendu avant la sauvegarde ; drapeau « Imprimer »
  posé ; QuadPoints dans l'ordre haut-gauche, haut-droit, bas-gauche, bas-droit.
- **Polices CJK** : table de correspondance `FPDF_SetSystemFontInfo` en M2, plus un pack Noto
  CJK facultatif dans l'installeur.
- **Permissions des PDF chiffrés** : lues par l'API brute de PDFium.

## Ordre de construction

**M0. Spike moteur natif (1 semaine).** Critères de réussite, mesurés sur le corpus public :
1. 30 PDF variés rendus sans défaut visible (polices non embarquées, transparence, CJK, scans) ;
2. tuile de 512 px rendue et affichée dans la WebView en moins de 30 ms ; première page en moins
   de 300 ms sur un PDF de 1 000 pages ; défilement fluide à 60 images par seconde ;
3. un PDF de 2 Go s'ouvre en lecture par blocs, avec moins de 300 Mo de mémoire ;
4. un surlignage et une note enregistrés en incrémental s'affichent dans Chrome et Firefox ;
5. un PDF chiffré AES-256 s'ouvre avec son mot de passe et se réenregistre chiffré ;
6. un formulaire AcroForm rempli et enregistré se relit correctement ailleurs ;
7. une page s'imprime en vectoriel sur une imprimante PDF Windows (« Microsoft Print to PDF ») ;
8. `cargo-deny` accepte toutes les licences.

Si le transfert des tuiles est trop lent, on compare trois formats : RGBA brut par protocole,
WebP sans perte, et canal binaire IPC.

**M1. Tranche verticale (2 semaines), moche mais complète.** Installer le setup → double-clic sur
un .pdf → rendu → surlignage → Ctrl+S → réouverture, le surlignage est là. NVDA lit la couche
de texte dès cette étape.
- Écrans : S03 (brut), S01 (liste des récents seulement)
- Tables : `recent_files`
- Commandes : `get_launch_files`, `open_file_dialog`, `doc_open`, `pdfpage://`,
  `doc_text_layer`, `annot_add`, `doc_save`
- CI : build Rust + front, `PDFReader-Setup.exe` NSIS (non signé), contrôle des licences,
  publication sur le dépôt public de versions ; vérifier qu'une mise à jour installée par
  l'updater ne déclenche pas SmartScreen

**M2. Indispensables de la phase 1 (7 à 9 semaines), par domaine.**

| lot | contenu (features.csv, priorité must) | écrans | tables / commandes |
| --- | --- | --- | --- |
| lecture | onglets, rendu progressif, zoom, modes d'affichage, navigation, rotation, thèmes, liens, copier du texte, mot de passe, permissions | S03, S04 | `view_states`, `doc_open` |
| recherche | Ctrl+F | S05 | `doc_search` |
| navigation | vignettes, signets (lecture) | S06, S07 | — |
| accueil | récents et favoris | S01 | `recent_files` |
| annotations | surligner / souligner / barrer, note, zone de texte et légende, dessin et gomme, propriétés, panneau Commentaires, nom d'auteur | S03, S08 | `annot_*`, `preferences` |
| formulaires et signature | AcroForm, formulaire plat, créer et mémoriser sa signature | S11, S12 | `field_set`, `doc_place_signature`, `saved_signatures` |
| fichier | enregistrer / enregistrer sous, alerte de modifications non enregistrées, récupération | S03 | `doc_save`, `watch_file`, `recovery_snapshots` |
| impression | impression vectorielle native : plages, échelle, recto-verso, commentaires | S13 | `print` |
| interface et accessibilité | préférences, raccourcis clavier, FR / EN, lecteurs d'écran, contraste élevé, zoom de l'interface | S14 | `preferences` |
| installation et légal | setup NSIS, association .pdf, instance unique, mises à jour sur consentement, À propos avec Licences tierces, EULA dans l'installeur, page de téléchargement | S35 | `check_updates` |

**M3. Importantes, puis optionnelles, de la phase 1 (4 à 6 semaines).**
- Should : vue précédente / suivante, plein écran et mode lecture (S10), recherche avancée,
  modifier les signets, panneau Pièces jointes (S09), barre d'actions rapides personnalisable,
  restaurer la dernière vue, formes, tampons prédéfinis, réponses et statuts des commentaires,
  propriétés du document (S15), vue protégée, calculs JavaScript des formulaires (QuickJS),
  lecture à voix haute, export et import des préférences, **moteur dans un processus séparé**,
  setup « hors ligne » avec WebView2 embarqué.
- Could : défilement automatique, calques, articles, impression en livret / affiche, recherche
  dans plusieurs PDF, versions macOS (DMG) et Linux (AppImage / .deb).

**M4. Corrections issues de `/replica-entrepreneur`** : les plaintes réelles des utilisateurs de
Reader (lourdeur, pression pour passer à l'offre payante, publicités pour les outils payants…)
deviennent des tâches.

**Estimation de la phase 1** : 14 à 18 semaines pour une personne à plein temps, M0 compris.
