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
