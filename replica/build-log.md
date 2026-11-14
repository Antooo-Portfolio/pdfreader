# Journal de construction

Une ligne par écran ou par jalon : date, état, ce qui manque, ce qui a été plus dur que prévu.

## M1 — tranche verticale (2026-11-09)

Parcours validé de bout en bout, **dans l'application installée** par le setup :
installer `PDFReader_0.1.0_x64-setup.exe` (6,2 Mo, sans droits admin) → ouvrir un PDF passé en
argument (équivalent du double-clic) → première tuile affichée en 57 à 118 ms → couche de texte
(500 mots) → sélection d'un mot → surlignage → Ctrl+S (incrémental, original intact, /AP présente,
drapeau Imprimer) → fermeture → réouverture : le surlignage est là → fichier ajouté aux récents.
Scénario automatique : `PDFREADER_E2E=rapport.json PDFReader.exe fichier.pdf` (voir
`packages/viewer/src/e2e.ts`). Instance unique vérifiée : un second lancement ouvre son fichier dans
un nouvel onglet de la fenêtre existante.

| ID | date | état | manque | plus dur que prévu |
| --- | --- | --- | --- | --- |
| S03 Vue document | 2026-11-09 | partiel (brut, comme prévu en M1) | panneaux latéraux, recherche, autres annotations, rotation, modes d'affichage, menu de zoom « ajuster », aperçu basse résolution, sélection au clavier, liens | positionner la couche de texte (mise à l'échelle horizontale mot par mot) ; une fausse alerte « apparence absente » due à un contrôle mal écrit (`'AP'` au lieu de `'/AP'` avec pikepdf), 30 minutes perdues |
| S01 Accueil | 2026-11-09 | partiel (récents seulement, comme prévu) | favoris, recherche, vue grille, onglets Récents / Favoris | rien |
| S04 Mot de passe | 2026-11-09 | codé, non testé | test de bout en bout avec `09-chiffre-aes256.pdf` | — |
| Installation | 2026-11-09 | fait | ProgID de l'association à renommer (`PDF` → `PDFReader.Document`) ; l'installeur Tauri écrit la valeur par défaut de `HKCU\Software\Classes\.pdf` (sans effet tant que Windows a un choix utilisateur, mais contraire au principe « proposer, pas imposer ») → modèle NSIS personnalisé en M2 | — |

### Définition de « fini » (M1)

- [x] parcours complet sans erreur, dans l'app installée
- [x] états : vide (aucun récent), chargement (ouverture), erreurs (introuvable, endommagé, mot de passe, fichier modifié ailleurs, fichier verrouillé), modifications non enregistrées
- [~] clavier seul : ouvrir, enregistrer, fermer, zoomer, naviguer, changer d'onglet : oui ; **sélectionner du texte au clavier : non** (prévu en M2)
- [~] largeurs : appli de bureau, fenêtre minimale 640 px ; 390 px sans objet
- [x] aucun texte repris de l'original
- [x] features.csv mis à jour (must : 8 oui, 14 partiels, 32 non)
- [x] captures : `replica/clone-screens/S01.png`, `S03.png`
- [ ] test manuel avec NVDA
- [x] commits : voir l'historique git

### Notes techniques

- Le banc WebView du spike M0 (`apps/desktop/src/main.ts`) a été remplacé par la vraie interface ; ses résultats restent dans `replica/m0-report.md`.
- PDFium écrit une clé privée `/PDFIUM_HasGeneratedAP` dans les annotations dont il génère l'apparence : sans effet ailleurs, à retirer plus tard si on veut des fichiers parfaitement propres.
- La sauvegarde écrit maintenant directement dans un fichier temporaire (plus de copie en mémoire), même pour 2 Go.

## M2 — lot « lecture », recherche, vignettes, signets (2026-11-09)

Validé dans l'application compilée en release, par le scénario automatique étendu
(`PDFREADER_E2E`, partie `m2` de `packages/viewer/src/e2e.ts`) et par des tests du moteur
(`cargo test -p pdfreader-engine --test reading`, sur un PDF fabriqué dans le test : liens, signets
imbriqués, recherche, droits ; plus les droits du fichier AES-256 du corpus).

Résultats du scénario : signets lus ; recherche moteur de « contrat » dans 10 pages en 31 ms
(85 résultats) ; recherche par Ctrl+F dans l'interface (« 1 sur 85 », résultat courant surligné) ;
rotation à 90° : la page passe en paysage et la sélection d'un mot donne les mêmes coordonnées PDF
qu'avant (écart maximal 0,6 pt) ; fichier AES-256 : `password_required` sans mot de passe,
`wrong_password` avec un mauvais, ouverture avec le bon, copie interdite et impression autorisée
lues correctement. Contrôles visuels par captures : deux pages en continu + page entière + panneau
Vignettes avec la page 37 restaurée (S06), thème sombre + vue tournée + panneau Signets (S07), une
page à la fois (fenêtre de 1100 px), dialogue de mot de passe (S04).

| ID | date | état | manque | plus dur que prévu |
| --- | --- | --- | --- | --- |
| S03 Vue document | 2026-11-09 | partiel | annotations autres que le surlignage, bandeaux formulaire / signé / vue protégée, sélection au clavier, annulation des tuiles invisibles, table des polices CJK, barre d'actions rapides | l'ancrage du défilement quand le zoom, la rotation ou le mode changent ; la page restaurée était écrasée par un premier calcul de défilement fait avant que la zone soit mesurée (corrigé) |
| S04 Mot de passe | 2026-11-09 | fait | — | — |
| S05 Recherche | 2026-11-09 | partiel | recherche avancée (commentaires, signets, plusieurs PDF : M3), option « ignorer les accents », capture d'écran (la barre ne s'ouvre qu'au clavier, l'outil de capture ne sait pas taper) | le gestionnaire de clavier appelait `contains()` sur une cible qui n'est pas un élément (événement envoyé à `window`) : exception silencieuse, Ctrl+F sans effet dans le test (corrigé) |
| S06 Vignettes | 2026-11-09 | fait (lecture) | menu contextuel pivoter / supprimer / insérer / extraire (outils de pages, phase 2), sélection multiple | — |
| S07 Signets | 2026-11-09 | fait (lecture) | ajouter / renommer / supprimer (M3) | — |
| Accueil (S01) | 2026-11-09 | inchangé | favoris, recherche, grille | — |

### Notes techniques

- Rotation de la vue : la page entière (tuiles, résultats, texte, liens) est tournée d'un bloc en
  CSS ; les tuiles restent rendues sans rotation (cache partagé). `selection.ts` ramène les
  rectangles de la sélection sur la page non tournée avant de les fusionner par ligne.
- Mise en page calculée dans `layout.ts` (fonctions pures) : rangées d'une ou deux pages, position
  absolue de chaque page, seules les rangées proches de l'écran sont montées.
- L'aperçu flou d'une page utilise exactement l'URL de sa vignette : une seule image en cache.
- Après Ctrl+S, l'empreinte du fichier change : `Db::rekey` la reporte sur le récent et sur son
  état de vue (sinon la vue mémorisée était perdue à chaque enregistrement).
- Les liens web passent par la commande `open_url`, qui n'accepte que http, https et mailto, et
  seulement après la boîte de confirmation.
- Les signets d'un PDF piégé sont bornés (20 000 entrées, profondeur 48).
- Non fait dans ce lot : table de correspondance des polices CJK (`FPDF_SetSystemFontInfo`),
  sélection du texte au clavier, Lingui (FR / EN).

## M2 — lots « accueil » et « annotations » (2026-11-09)

Validé dans l'application compilée en release par le scénario automatique (partie `annotations`
de `packages/viewer/src/e2e.ts`, 11 contrôles) et par un test du moteur
(`cargo test -p pdfreader-engine --test annotations`).

Scénario : nom d'auteur changé puis utilisé ; souligné d'un mot sélectionné ; note (son éditeur
s'ouvre) ; dessin ; souligné passé du rouge au bleu ; dessin effacé ; gestes simulés à la souris
(outil Dessin au clavier « D », tracé sur la page, barre de style de l'outil, sélection du tracé
par un clic, barre « Sélection : Dessin », suppression par la touche Suppr) ; panneau Commentaires
avec les trois commentaires de la page ; enregistrement, fermeture, réouverture : souligné bleu et
note (texte et auteur) toujours là. Test du moteur : création des quatre types, lecture (couleur,
opacité, auteur, dates, zones, tracés), rendu vérifié au pixel (surlignage, tracé, icône de note),
changement de couleur visible au rendu, suppression, enregistrement incrémental et relecture.
Captures : accueil en vignettes avec favoris (S01), panneau Commentaires (S08) ; éditeur de note
et barre de propriétés vérifiés sur des images prises pendant le scénario (variable
`PDFREADER_E2E_PAUSE`).

| ID | date | état | manque | plus dur que prévu |
| --- | --- | --- | --- | --- |
| S01 Accueil | 2026-11-09 | fait (local) | onglets Fichiers / Accords (services en ligne : sans objet), panneau « Détails rapides » | — |
| S03 Vue document (annotations) | 2026-11-09 | partiel | zone de texte et légende, formes, tampons, déplacer ou redimensionner un commentaire, annuler / rétablir | PDFium refuse de lire ou de changer la couleur d'une annotation qui a déjà une apparence : la couleur est lue sur les tracés de l'apparence, et une modification retire d'abord l'apparence (et l'indicateur privé de PDFium, qui sinon bloque la régénération) |
| S08 Commentaires | 2026-11-09 | partiel | réponses et statuts (should, M3), filtre par couleur, non lus | — |

### Notes techniques

- Module `crates/engine/src/annotations.rs` : tout en API brute `FPDFAnnot_*`. Identifiant d'un
  commentaire : son /NM (posé à la création), sinon son rang sur la page ; l'interface relit la
  liste de la page après chaque modification.
- Opacité : l'alpha de `FPDFAnnot_SetColor` devient /CA ; lecture par `FPDFAnnot_GetNumberValue`.
- Le tracé en cours de dessin est gardé dans une référence et non dans l'état React : avec des
  mouvements rapides, des points se perdaient (trouvé par le scénario).
- Après une modification, la page garde ses anciennes tuiles jusqu'à ce que les nouvelles soient
  chargées (plus de page floue qui clignote, vu sur les captures).
- Choisir un outil de création désélectionne le commentaire courant (sinon la barre de l'outil
  n'apparaissait pas, trouvé par le scénario).
- Le scénario écrit dans la base locale réelle (nom d'auteur, récents) ; remis en état à la main
  après les essais. À isoler (dossier de données dédié aux tests) avant la CI.

## M2 — lot « formulaires et signature » (2026-11-09)

Validé dans l'application compilée en release par le scénario automatique (partie `fill` de
`packages/viewer/src/e2e.ts`) et par deux tests du moteur (`cargo test -p pdfreader-engine
--test fill`).

Scénario, sur le formulaire du corpus : bandeau « formulaire » affiché ; six champs lus ; « Nom »
tapé dans le champ HTML puis validé en quittant le champ, case « J'accepte » cochée d'un clic,
bouton radio « annuelle » choisi, pays changé dans la liste déroulante : les quatre valeurs sont
passées par le moteur de formulaires de PDFium ; texte libre, coche et signature mémorisée posés ;
enregistrement, fermeture, réouverture : valeurs et trois tampons toujours là. Tests du moteur :
même saisie sur tous les types de champ puis relecture du fichier ; texte, coche et signature
avec transparence vérifiés au pixel, puis relecture. Captures : formulaire rempli et tampons (S11),
outil Signer et boîte de création de la signature (S12).

| ID | date | état | manque | plus dur que prévu |
| --- | --- | --- | --- | --- |
| S11 Remplir et signer | 2026-11-09 | partiel | listes à choix multiples, calculs et validations JavaScript (M3, QuickJS), formats de date et de nombre des champs, zone de texte /FreeText avec cadre | — |
| S12 Signature | 2026-11-09 | fait | signature numérique à certificat (hors phase 1) | les tampons ne s'affichaient pas : PDFium fixe la boîte de l'apparence au premier objet ajouté, il faut donc poser le rectangle de l'annotation AVANT d'y ajouter le texte, le tracé ou l'image |

### Notes techniques

- Champs : de vrais contrôles HTML (`input`, `textarea`, `select`) posés sur chaque widget, avec
  un fond opaque qui masque l'apparence rendue dessous ; à la validation, la valeur passe par
  `FORM_SetFocusedAnnot` / `FORM_ReplaceSelection` / `FORM_SetIndexSelected` ou un clic simulé
  (cases et boutons radio), puis la perte du focus : PDFium met à jour /V et toutes les apparences.
- Texte libre, coche, signature : annotations Tampon (/Stamp) dont l'apparence contient nos objets
  (`FPDFAnnot_AppendObject`, seul type avec l'encre à l'accepter). PDFium ne génère pas
  l'apparence d'une zone de texte /FreeText. Une clé privée `PDFReaderKind` les distingue ; leur
  aspect ne se modifie pas (l'apparence ne se régénère pas), le texte se change en recréant le
  tampon depuis le panneau Commentaires.
- Signature : image PNG avec transparence (texte tapé rendu dans un canevas avec Caveat, OFL ;
  dessin ; image avec le fond blanc retiré), gardée en data URL dans `saved_signatures`, jamais
  envoyée nulle part ; posée en image bitmap BGRA (PDFium crée le masque de transparence).
- Le scénario écrit encore dans la base locale réelle (auteur, signature de test) : remis en état
  à la main. Toujours à isoler avant la CI.

## M2 — lots « impression », « préférences » et « fichier » (2026-11-12)

Validé dans l'application compilée en release par le scénario automatique (partie `settings` de
`packages/viewer/src/e2e.ts`), par deux lancements qui simulent un plantage (étapes `crash` puis
`recover`) et par les tests du moteur (`cargo test -p pdfreader-engine --test print`).

**Les tests de bout en bout n'écrivent plus dans la base de l'utilisateur** : avec PDFREADER_E2E,
l'application prend un dossier de données à part, à côté du rapport (`e2e-data`). Vérifié :
l'empreinte de la vraie base est identique avant et après toutes les exécutions.
PDFREADER_DATA_DIR permet aussi de choisir ce dossier (captures, version portable).

Scénario : plages de pages (« 1-3, 5, 8- », plages à l'envers, doublons, erreurs) ; Ctrl+P ouvre
la boîte Imprimer avec les imprimantes et l'aperçu ; Ctrl+K ne l'empile pas par-dessus ;
impression réelle des pages 1 et 3 vers « Microsoft Print to PDF » : deux pages envoyées, deux
événements de progression, deux pages dans le fichier produit ; Préférences (Ctrl+K), taille de
l'interface à 125 %, raccourcis à une touche désactivés puis réactivés ; un fichier ouvert
remplacé sur le disque : bandeau, rechargement, contenu nouveau, bandeau parti ; copie de
récupération faite puis effacée à l'enregistrement. Plantage simulé : modification, copie,
sortie sans nettoyage, fichier d'origine intact ; au lancement suivant la récupération est
proposée, le document rouvert contient la modification, l'enregistrement l'écrit dans le
fichier d'origine et efface la copie. Tests du moteur : formulaire rempli imprimé même sans les
commentaires, dessin imprimé seulement avec les commentaires, croix « Remplir et signer » toujours
imprimée, deux pages dans l'ordre demandé (3 puis 1), impression en image (basse qualité),
orientation automatique portrait / paysage / portrait.

| ID | date | état | manque | plus dur que prévu |
| --- | --- | --- | --- | --- |
| S13 Imprimer | 2026-11-12 | fait | plusieurs pages par feuille, livret, affiche (M3, « could ») ; choix du bac et du format de papier (réglages du pilote) | les champs de formulaire remplis ne s'imprimaient pas en vectoriel : chaque page est copiée dans un document temporaire et aplatie pour l'impression (`FPDFPage_Flatten`), le document ouvert n'est jamais touché ; l'impression en image sortait écrasée (format 24 bits déclaré en 32 bits) |
| S14 Préférences | 2026-11-12 | fait | langue anglaise (Lingui), export / import des préférences (M3), réglages de sécurité (vue protégée, M3) | Ctrl+K ouvrait les Préférences par-dessus la boîte Imprimer : aucun raccourci global ne réagit plus quand une boîte modale est ouverte (Suppr aurait pu effacer un commentaire derrière) |
| Fichier (S03) | 2026-11-12 | fait | — | — |

### Notes techniques

- Impression : `crates/engine/src/print_win.rs`, réglages du pilote (DEVMODE : recto verso, copies,
  orientation) validés par `DocumentPropertiesW`, orientation changée page par page avec
  `ResetDCW`, centrage sur la feuille physique. Le thread moteur imprime une page chaque fois qu'il
  n'a aucune autre commande : l'affichage reste fluide pendant une longue impression, et
  l'annulation est prise en compte entre deux pages (`AbortDoc`).
- Copies de récupération : enregistrement incrémental du document en mémoire dans
  `%APPDATA%\app.pdfreader.desktop\recovery\`, une seule par document (la précédente est supprimée), table
  `recovery_snapshots`. Effacées à l'enregistrement, à la fermeture voulue (y compris « Ne pas
  enregistrer ») et au rechargement. Les fichiers orphelins sont supprimés au démarrage.
- Fichier modifié ailleurs : date de modification comparée toutes les 5 s et au retour sur la
  fenêtre ; bandeau « Recharger » ou « Enregistrer mes modifications sous… ».
- Tests du moteur : une seule instance de PDFium par binaire de test (`tests/common`), PDFium ne
  se rechargeant pas après libération dans un même processus.

## M2 — fin du jalon (2026-11-12)

Dernier lot de M2 : polices CJK, sélection au clavier, zone de texte et légende, interface en
anglais, installation et légal, mises à jour sur consentement, site de téléchargement,
intégration continue. Version 0.2.0. Validé par le scénario de bout en bout complet (toutes
les parties, dont « À propos » : 340 composants), le plantage simulé puis la récupération, les 12
tests Rust (moteur et application), le contrôle des traductions et les deux contrôles de
licences ; la base réelle de l'utilisateur est inchangée après tous les essais.

**Installation, vérifiée sur ce poste** (installation silencieuse du setup 0.2.0, puis
désinstallation et réinstallation, dossier de données sauvegardé avant) :
- identifiant `PDFReader.Document`, PDFReader proposé dans « Ouvrir avec » et dans Paramètres >
  Applications par défaut (Capabilities + RegisteredApplications) ;
- le lecteur choisi par l'utilisateur (ici Acrobat, UserChoice) n'est jamais touché, et la valeur
  par défaut de `.pdf` est remise telle qu'elle était : la macro APP_ASSOCIATE de Tauri la
  remplaçait, un script NSIS (`installer-hooks.nsh`) la restaure après l'installation ;
- migration depuis la 0.1.0 : son identifiant générique « PDF », posé comme lecteur par défaut,
  est retiré (seulement s'il lance PDFReader), sauvegarde comprise ;
- désinstallation : toutes nos clés retirées, données conservées ;
- contrat de licence FR / EN affiché par l'installeur ; LICENCE.txt, THIRD-PARTY-NOTICES.txt et
  third-party.json installés avec l'application.

| ID | date | état | manque | plus dur que prévu |
| --- | --- | --- | --- | --- |
| S35 À propos | 2026-11-12 | fait | — | la version de PDFium venait d'un fichier absent de l'installation : inscrite à la compilation (build.rs) |
| Mises à jour | 2026-11-12 | fait | installation d'une vraie mise à jour (attend une 0.2.1) | l'essai de bout en bout avec un serveur local exige une version de test qui accepte le HTTP non chiffré : construction refusée par le contrôle de sécurité de l'environnement, essai abandonné ; la chaîne de signature est vérifiée par un test Rust (même vérificateur que l'updater : setup construit accepté, setup modifié d'un octet refusé) |
| Site | 2026-11-12 | publié | — | GitHub Pages sert le site par le domaine personnalisé de l'organisation (portfolio.antonyrodrigues.fr) |
| CI | 2026-11-12 | fait | — | l'action cargo-deny est un conteneur Linux, refusé sur Windows : outil installé à la place |
| Polices CJK | 2026-11-12 | fait | — | le correspondant de Windows rend toujours « une » police (latine) : il faut vérifier le nom de la police obtenue avant de l'accepter |
| Sélection au clavier | 2026-11-12 | fait | — | `Selection.modify` se perd dans la couche de texte (mots en position absolue) : navigation écrite à la main sur la liste des mots |
| Zone de texte, légende | 2026-11-12 | fait | — | — |
| Anglais | 2026-11-12 | fait | — | des variables locales nommées `t` masquaient la fonction de traduction (boucles, minuteries) : renommées |

### Ce qui reste à faire par l'utilisateur

- **Clé de signature des mises à jour** : `%USERPROFILE%\.tauri\pdfreader-updater.key` (sans mot
  de passe), copiée sur le second disque et dans les secrets du dépôt de code. Une copie hors de
  l'ordinateur reste à faire : sans elle, plus aucune mise à jour ne pourra être publiée pour les
  versions déjà installées.
- Tester avec NVDA, et avec le mode contraste élevé de Windows activé.
- Une impression papier, recto verso compris, sur l'imprimante réelle.

### Notes techniques

- `tools/licenses/notices.py` : composants livrés (dépendances Rust normales pour Windows, paquets
  npm de production, PDFium et ses bibliothèques, polices) et texte de chaque licence, sans doublon.
- `tools/release/prepare.py` : `latest.json` (signature et adresse de la Release), copie des
  fichiers, pages du site à jour.
- `tools/i18n/` : extraction des clés, traductions anglaises, contrôle (`npm run i18n:check`).
- Rotation de la vue déplacée sur Ctrl+Alt+flèches (Ctrl+Maj+flèche étend la sélection).

### Vérifications complémentaires (2026-11-12)

- **Arbre d'accessibilité** (ce que lit un lecteur d'écran), relevé par UI Automation sur
  l'application en marche (`tools/a11y/uia-dump.ps1`) : 18 boutons, tous nommés ; outils exposés
  comme boutons radio ; document annoncé « 08-formulaire-acroform.pdf, page 1 sur 1 » ; texte de la
  page exposé mot par mot ; champs du formulaire nommés (« Nom », « J'accepte », « Formule :
  mensuelle ») ; bandeau en zone d'état ; une boîte modale masque bien le reste de la fenêtre. À
  améliorer : les champs arrivent après tout le texte de la page, pas à côté de leur libellé. NVDA
  lui-même n'est pas installé sur ce poste : l'écoute reste à faire.
- **Contraste élevé** simulé (forced-colors) sur la page des composants : interface lisible,
  sélection visible. La simulation a montré un risque réel : le mode impose la couleur du texte, y
  compris celle de la couche de texte invisible ; avec le contraste élevé de Windows, le texte du
  PDF serait apparu en double. Corrigé (`forced-color-adjust: none` sur la couche de texte, les
  images de page et les tracés). Le mode de Windows lui-même n'a pas été activé (réglage système).
- **Impression papier** : l'imprimante réseau était hors ligne (ne répond pas sur le réseau) ; rien
  n'a été envoyé, pour ne pas laisser un travail en attente. Test prêt :
  `PDFREADER_TEST_PRINTER="<nom de l'imprimante>" cargo test -p pdfreader-engine --test print real_printer -- --ignored`.
- **Clé de signature** copiée sur un second disque, hors du dépôt ; une copie hors de
  l'ordinateur reste à faire.

### Publication (2026-11-12)

- Un seul dépôt public, `Antooo-Portfolio/pdfreader` : code, versions (Releases) et site. Il
  s'appelait d'abord `pdfreader-releases` (versions et site seulement, code dans un dépôt privé) ;
  à la demande de l'utilisateur, le dépôt privé a été supprimé et le dépôt public renommé. GitHub
  redirige les anciennes adresses : la 0.2.0, qui interroge
  `…/pdfreader-releases/releases/latest/download/latest.json`, trouve toujours le flux (ne jamais
  recréer un dépôt nommé `pdfreader-releases`, la redirection cesserait). Le contrat de licence
  reste propriétaire : le code est visible, pas libre.
- Secret `TAURI_SIGNING_PRIVATE_KEY` : la CI construit un setup signé et les fichiers de version
  (artefact « setup »).
- Release v0.2.0 (setup, `.sig`, `latest.json`) ; étiquette sur le commit qui a construit le setup.
- Site : `site/` déployé sur GitHub Pages par `.github/workflows/pages.yml`, servi à
  https://portfolio.antonyrodrigues.fr/pdfreader/ (domaine de l'organisation).
- Vérifié : `latest.json` et le setup téléchargés depuis la Release sont identiques aux fichiers
  construits ; signature acceptée par le test Rust ; adresse du flux présente dans l'exécutable.
- Le setup construit par la CI passe le même test de signature (`PDFREADER_SETUP=chemin`).
- Étape e2e `PDFREADER_E2E_STAGE=update` : l'application réelle interroge le flux publié. Construite
  en 0.2.0 : « à jour » (aucune proposition, aucune erreur) ; construite en 0.1.9 : 0.2.0 proposée.
- Publier une version : monter la version dans `tauri.conf.json`, `python tools/release/build.py`
  (clé lue dans le dossier de l'utilisateur ; ou prendre l'artefact « setup » de la CI), `python tools/release/prepare.py --notes "…"`, puis
  `gh release create vX.Y.Z -R Antooo-Portfolio/pdfreader` avec les trois fichiers de
  `target/release-upload/`.

## M3 — lot « lecture » (2026-11-12)

Branche `m3-lecture`. Vue précédente / suivante, mode lecture et plein écran, propriétés du
document (S15), export et import des préférences. Partie `m3reading` du scénario de bout en bout
(historique avec Alt+flèches, mode lecture et Échap, plein écran avec clic pour avancer et retour
au mode du document, Propriétés avec l'onglet Polices, export puis import des préférences et
fichier refusé) ; test du moteur `document_properties` (métadonnées, version, polices, Courier non
incorporée, chiffrement AES-256 R6). Scénario complet passé quatre fois de suite.

| ID | date | état | manque | plus dur que prévu |
| --- | --- | --- | --- | --- |
| Vue précédente / suivante | 2026-11-12 | fait | — | le premier saut après un retour sur l'onglet échouait : une « ancre » prise lors d'un redimensionnement sans effet sur la mise en page (hauteur seule) restait en attente et ramenait la vue en arrière au changement de page suivant ; les ancres non consommées sont maintenant effacées après chaque rendu |
| S10 Mode lecture, plein écran | 2026-11-12 | fait | défilement automatique (could) | en sortant du plein écran, la vue retombait en page 1 : le recalage était posé dans un effet, qui passe après celui de la mise en page ; il est décidé pendant le rendu |
| S15 Propriétés du document | 2026-11-12 | fait (lecture) | modifier les métadonnées (could) ; type de chaque police | polices lues par l'API brute de PDFium, objets de formulaire imbriqués compris (profondeur limitée) |
| Export / import des préférences | 2026-11-12 | fait | — | — |

Corrigé au passage : quatre phrases de l'interface échappaient à la traduction (bandeau
« Recharger », bandeau des droits du document, « Ouverture de… », demande de mot de passe) ;
le test du formulaire attend chaque saisie avant la suivante (une exécution sur quatre perdait le
bouton radio et la liste, cliqués dans la même milliseconde).

## M3 — lot « navigation » (2026-11-13)

Branche `m3-navigation` (partie de `m3-lecture`). Pièces jointes (S09), recherche avancée, lecture
à voix haute, vue protégée. Partie `m3navigation` du scénario : liste des pièces jointes (nom
piégé nettoyé), enregistrement d'une pièce jointe, ouverture de l'annexe PDF dans un onglet,
refus d'ouvrir un `.exe` ; 85 résultats avec extraits pour « contrat », saut à la page 4, note
retrouvée par la recherche dans les commentaires ; lecture à voix haute démarrée (6 voix
installées) puis arrêtée au clavier ; fichier marqué « venu d'Internet » ouvert en vue protégée,
outils verrouillés, puis déverrouillés. Test du moteur `attachments_snippets_and_internet_mark`.
Corpus : `12-pieces-jointes.pdf` (texte, PDF, nom piégé `..\..\danger.exe`).

| ID | date | état | manque | plus dur que prévu |
| --- | --- | --- | --- | --- |
| S09 Pièces jointes | 2026-11-13 | fait | pièces jointes des commentaires /FileAttachment (could) | — |
| Recherche avancée | 2026-11-13 | fait | recherche dans plusieurs PDF d'un dossier (could) | rouvrir le panneau avec une nouvelle requête gardait l'ancienne (état initialisé une seule fois) : la requête transmise est reprise à chaque ouverture |
| Lecture à voix haute | 2026-11-13 | fait | choix de la voix et de la vitesse | les voix de Windows coupent les textes longs : lecture par morceaux de 240 caractères, aux fins de phrase |
| Vue protégée | 2026-11-13 | fait | — | — |
| Modifier les signets | — | reporté | créer, renommer, supprimer | PDFium ne sait pas écrire de signets : il faudra écrire le dictionnaire /Outlines nous-mêmes (mise à jour incrémentale) |

## M3 — lot « commentaires » (2026-11-14)

Branche `m3-commentaires`. Formes, tampons prédéfinis, réponses et statuts. Partie `m3comments`
du scénario : rectangle tracé à la souris (aperçu pendant le glisser), polygone posé par clics
puis Entrée, ellipse remplie, ligne, flèche, nuage, tampon « Brouillon » daté ; réponse saisie
dans le panneau Commentaires, statut « Accepté », coche ; tout relu à l'identique après
enregistrement ; supprimer le commentaire emporte sa réponse. Test du moteur
`shapes_stamps_replies_status` (rendu vérifié au pixel : contour, intérieur, ligne, festons du
nuage ; enregistrement et relecture).

| ID | date | état | manque | plus dur que prévu |
| --- | --- | --- | --- | --- |
| Formes | 2026-11-14 | fait | modifier les sommets d'une forme posée ; remplissage des polygones | PDFium ne génère l'apparence que des rectangles et ellipses, et ne sait écrire ni /L ni /Vertices : les autres formes sont des tracés d'encre marqués de leur nature |
| Tampons prédéfinis | 2026-11-14 | fait | tampons personnalisés (could) | — |
| Réponses et statuts | 2026-11-14 | fait | — | PDFium ne sait pas écrire la référence /IRT : nos réponses sont reliées par une clé privée et n'ont pas d'apparence (invisibles sur la page, comme ailleurs) ; les fils d'autres logiciels sont lus normalement |

**Défaut ancien trouvé par ce lot** : la liste des commentaires arrivait du moteur avec des noms
de champs en `snake_case` (`reply_to`, `text_box`, `font_size`) alors que l'interface attend du
`camelCase`. Aucune réponse n'était donc rattachée à son commentaire, et la modification du texte
d'une zone de texte (M2) passait par le mauvais chemin (texte du commentaire changé, texte affiché
inchangé). Corrigé dans la sérialisation. Corrigé aussi : la pastille de couleur des rectangles
et ellipses montrait le remplissage au lieu du contour ; trois textes du panneau Commentaires
n'étaient pas traduits.

## M3 — lot « signets et barre d'outils » (2026-11-14)

Branche `m3-signets`. Partie `m3bookmarks` du scénario : deux signets créés depuis le panneau à
la vue actuelle et renommés, remontée, troisième imbriqué sous le précédent ; enregistrés, relus
depuis le fichier avec leurs pages (1, 3, 5) ; clic sur un signet = navigation, Suppr le retire ;
document chiffré non modifiable ; outils masqués puis réaffichés. Test du moteur
`outline_write_and_reload` (titres accentués, imbrication, ordonnée, lien web, remplacement,
vidage, enregistrement PDFium par-dessus, document chiffré refusé et intact).

| ID | date | état | manque | plus dur que prévu |
| --- | --- | --- | --- | --- |
| Modifier les signets | 2026-11-14 | fait | glisser-déposer dans l'arbre ; documents chiffrés | PDFium ne sait pas écrire les signets : après son enregistrement, une seconde mise à jour incrémentale (lopdf, MIT) ajoute le nouvel arbre /Outlines et le catalogue ; fichiers de plus de 512 Mo refusés (lopdf charge le fichier en mémoire) |
| Barre d'outils personnalisable | 2026-11-14 | fait | ordre des outils | — |

Corrigé au passage : un clic sur un signet l'ouvrait sans le sélectionner (l'arbre ne
sélectionne qu'à la barre d'espace quand une action est définie) : impossible de le modifier
après un clic. Nouvelle dépendance `lopdf` 0.47 (licences vérifiées par cargo-deny ; mentions
des composants tiers régénérées : 366 composants).

## M3 — lot « calculs des formulaires » (2026-11-14)

Branche `m3-formulaires-js`. PDFium (sans V8) n'exécute pas le JavaScript des formulaires.
Après chaque saisie : contrôle de frappe (nombre attendu), validation du champ (valeur rétablie
et message si refusée), puis recalcul des champs calculés jusqu'à stabilité (10 passes au plus).
Les fonctions standard d'Acrobat sont calculées en Rust sans exécuter le code du document ; tout
autre script tourne dans QuickJS (rquickjs, MIT) : globales réduites à `getField`, `event`,
`app.alert`, quelques fonctions AF ; ni `require`, ni réseau, ni fichiers ; 150 ms et 16 Mo par
script. Les champs calculés sont souvent en lecture seule : le drapeau est levé le temps de la
saisie puis rétabli, pour que PDFium régénère l'apparence.

Corpus : `13-formulaire-calculs.pdf` (quantité × prix, notation simplifiée, TVA par script
personnalisé, somme, plage 0–100, nombres seulement, code de 4 caractères validé par script,
boucle sans fin, appel à `app.launchURL`). Test du moteur `form_calculations_and_sandbox` :
chaîne de calcul juste (37,5 / 7,5 / 45, puis remise), trois refus avec valeur rétablie, les deux
pièges échouent sans rien bloquer (moins de 1,5 s en tout), rien du système visible depuis un
script, mémoire limitée, valeurs et lecture seule conservées à l'enregistrement. Partie `m3forms`
du scénario : saisie dans l'interface, total relu à l'écran, message de refus, préférence coupée
puis rétablie.

| ID | date | état | manque | plus dur que prévu |
| --- | --- | --- | --- | --- |
| Calculs et validations | 2026-11-14 | fait | mise en forme d'affichage (AFNumber_Format : « 37,50 € ») ; scripts de frappe personnalisés ; ordre de calcul /CO (remplacé par des passes jusqu'à stabilité) | couper la préférence n'arrêtait que les scripts personnalisés (les calculs standard continuaient) : elle coupe désormais tout |

Mentions des composants tiers : QuickJS (code C embarqué dans rquickjs-sys) ajouté avec sa
propre licence et ses auteurs (371 composants).

## M3 — lot « moteur séparé » (2026-11-14)

Branche `m3-moteur-separe`. PDFium (C++ qui lit des fichiers non fiables) ne tourne plus dans
l'application : il vit dans un second `PDFReader.exe` lancé avec `--engine-host`, sans fenêtre ni
interface. Même exécutable, donc rien à ajouter au setup ni aux mentions tierces. Les demandes et
les réponses passent sur l'entrée et la sortie standard en trames (en-tête JSON + données binaires :
tuiles WebP, miniatures, images de signature, pièces jointes). Les numéros de document sont choisis
par l'application, pour survivre aux redémarrages.

- **Plantage** : fin du flux → les demandes en cours échouent (« engine_restarted », tuiles en 503),
  le moteur est relancé, chaque document est rouvert sous le même numéro avec une génération
  nouvelle (l'interface recharge tuiles, commentaires, champs) : depuis sa dernière copie de
  récupération s'il y en a une (modifications non enregistrées), sinon depuis le fichier. Le
  message dit sur quel document le moteur est tombé et ce qui est perdu.
- **Coupable** : le moteur traite les demandes dans l'ordre, la plus ancienne en attente est celle
  qui l'a fait tomber. Un document qui le fait tomber deux fois est fermé (pas de boucle de
  plantages) ; ses copies de récupération restent proposées au démarrage. Au-delà de 5 arrêts en
  une minute, le moteur n'est plus relancé et l'interface demande de redémarrer PDFReader.
- **Blocage** : surveillance d'un moteur muet (30 s pour l'affichage, 10 min pour ouvrir,
  enregistrer, chercher) → arrêté, puis même chemin qu'un plantage. Pas de surveillance pendant
  une impression : le pilote peut attendre l'utilisateur (« Enregistrer sous » de Microsoft Print
  to PDF), et le moteur a le droit de passer sa fenêtre au premier plan.
- **Objet de tâche Windows** : moteur tué avec l'application (vérifié en tuant l'application de
  force), mémoire plafonnée à 4 Go (une bombe de décompression arrête le moteur, pas la machine ;
  configuré, non éprouvé avec un vrai fichier piégé), pas de boîte « a cessé de fonctionner ».
- Ce n'est pas un bac à sable complet : le moteur garde les droits de l'utilisateur (il doit lire
  et écrire les fichiers, et imprimer).

Tests : `engine_host` (cargo) pilote le vrai processus : ouverture sous un numéro imposé, erreur
typée, 20 tuiles (3,06 ms par le moteur séparé contre 2,80 ms dans le même processus, soit
0,26 ms de surcoût), demande de plantage refusée hors test, flux corrompu → arrêt propre, plantage
volontaire → seul le moteur s'arrête, entrée fermée → le moteur s'arrête seul. Partie `m3engine` du
scénario (3 passages verts) : plantage pendant une demande sur B → A rouvert depuis sa copie
(note présente, onglet toujours « modifié »), B depuis le fichier, tuiles servies, message affiché,
aucune erreur parasite à l'écran ; deuxième plantage sur B → B fermé, A gardé ; blocage sur A →
arrêté en 3,3 s (surveillance raccourcie pour le test) puis relancé. Mémoire du moteur : 13 Mo
au repos.

| ID | date | état | manque | plus dur que prévu |
| --- | --- | --- | --- | --- |
| Moteur séparé | 2026-11-14 | fait | modifications faites depuis la dernière copie de récupération perdues au plantage (copie toutes les N minutes) ; pas de restriction des droits du moteur (jeton restreint, AppContainer) | le numéro de document de l'ouverture portait le même nom que celui de la demande dans l'en-tête : la première version ne répondait jamais (trouvé par le test du processus) |

## M3 — lot « setup hors ligne » (2026-11-14)

Branche `m3-setup-hors-ligne`. PDFReader affiche son interface avec WebView2. Windows 11 l'a
toujours ; le setup normal (8 Mo) le télécharge s'il manque, ce qui échoue sans Internet.
`python tools/release/build.py --offline` construit un second setup,
`PDFReader_<v>_x64-offline-setup.exe` (217 Mo), qui embarque l'installeur autonome « Evergreen »
de Microsoft (210 Mo) : extrait et lancé en silence (`/silent /install`) seulement si WebView2
n'est pas déjà inscrit, sans connexion ; le runtime installé se met ensuite à jour comme celui de
Windows. Pas de runtime figé (« fixed version ») : il ne recevrait jamais les correctifs de
sécurité.

- La signature Authenticode de l'installeur de Microsoft est vérifiée après la construction
  (« Valid », émise pour Microsoft Corporation), sinon le setup est supprimé.
- Le setup normal et sa signature d'updater sont mis de côté pendant la construction (même nom de
  fichier en sortie de Tauri) puis remis : la construction hors ligne ne les touche jamais.
- Pas proposé à l'updater (217 Mo pour une mise à jour) ; `prepare.py` le copie avec la version et
  ajoute au site (fr, en) le paragraphe qui l'annonce, à la première version qui le contient
  (avant, le lien de téléchargement mène à une version qui ne l'a pas).

Vérifié : installation silencieuse du setup hors ligne sur ce poste (17,5 s ; WebView2 déjà
présent, donc branche « déjà installé » ; aucun fichier laissé dans %TEMP%) ; scénario complet
vert sur l'application **installée** (moteur séparé compris : pdfium.dll trouvé dans le dossier
d'installation) ; puis 0.2.0 officielle réinstallée (empreinte SHA-256 identique à celle de la
Release). Non vérifié : la branche « WebView2 absent » sur un poste vierge — il faudrait Windows
Sandbox (non activé ici) ou une machine sans WebView2.

| ID | date | état | manque | plus dur que prévu |
| --- | --- | --- | --- | --- |
| Setup hors ligne | 2026-11-14 | fait | essai sur un poste sans WebView2 et sans Internet | le site ne peut annoncer la version hors ligne qu'avec la version qui la contient : annonce confiée à prepare.py |

## Version 0.3.0 — préparation (2026-11-14)

Branche `release-0.3.0` : version 0.3.0 dans tauri.conf.json, notes dans
`tools/release/notes/0.3.0.md` (la partie française va dans latest.json, affichée par l'updater),
mentions tierces régénérées (ordre désormais stable : tri par nom puis version), site : taille
(9 Mo) et paragraphe de la version hors ligne ajouté par prepare.py.

Construit : setup normal signé pour l'updater (9,3 Mo) et setup hors ligne (217 Mo, WebView2 signé
Microsoft) ; `target/release-upload/` : les deux setups, la signature, latest.json. Vérifié :
signature acceptée par la clé publique de l'application (test `updater_signature`), aucun chemin
personnel dans l'exécutable ; mise à niveau silencieuse 0.2.0 → 0.3.0 en 2,5 s, données de
l'utilisateur identiques octet pour octet, lecteur PDF par défaut (Acrobat) inchangé ; scénario
complet vert sur la 0.3.0 installée ; la 0.3.0 lit le flux publié (rien à proposer, la 0.2.0 étant
la dernière) ; 0.2.0 réinstallée pour essayer la vraie mise à jour par l'updater une fois la 0.3.0
publiée.
