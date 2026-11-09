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
- [ ] pas de dépôt git : aucun commit

### Notes techniques

- Le banc WebView du spike M0 (`apps/desktop/src/main.ts`) a été remplacé par la vraie interface ; ses résultats restent dans `replica/m0-report.md`.
- PDFium écrit une clé privée `/PDFIUM_HasGeneratedAP` dans les annotations dont il génère l'apparence : sans effet ailleurs, à retirer plus tard si on veut des fichiers parfaitement propres.
- La sauvegarde écrit maintenant directement dans un fichier temporaire (plus de copie en mémoire), même pour 2 Go.
