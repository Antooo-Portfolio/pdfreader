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
