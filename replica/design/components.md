# Composants : PDFReader (phase 1)

Application de bureau uniquement (Tauri, WebView2). La page `apps/design` est un outil de
développement qui s'ouvre dans le navigateur ; elle n'est jamais livrée.

Base : **React Aria Components** (Apache-2.0) pour le comportement et l'accessibilité,
**Tailwind v4** pour le style, **Lucide** (ISC) pour les icônes, **Inter** (OFL) pour le texte.
Toutes les couleurs passent par les rôles de `tokens.json` (`bg-surface`, `text-muted`,
`border-input`…) : jamais d'hexadécimal dans un composant.

## Règles communes

- **Rien d'Adobe** : ni icône, ni pictogramme, ni illustration, ni libellé repris. Les textes
  sont écrits par nous, en français et en anglais (Lingui). Pas de rouge de marque.
- **Disposition à nous** : le panneau de navigation (vignettes, signets) est à **gauche**, comme
  dans la plupart des lecteurs. Les commentaires sont dans un panneau **droit** contextuel. Les
  outils d'annotation sont dans la barre d'outils du haut, avec une barre de propriétés
  contextuelle. Il n'y a pas de barre flottante verticale.
- **Focus** : anneau de 2px `focus` avec un décalage de 2px, visible uniquement au clavier
  (`:focus-visible` / `data-focus-visible`). Jamais `outline: none` sans remplacement.
- **Cibles** : 28px minimum (WCAG 2.2 demande 24px) ; 40 à 48px en pointeur grossier (tactile),
  automatiquement par `--control-*`.
- **États obligatoires** pour tout élément interactif : défaut, survol, pressé, focus clavier,
  désactivé. Plus chargement, erreur et vide quand ils ont un sens.
- **Mouvement** : transitions de `--motion-fast` ou `--motion-base`, à 0 si
  `prefers-reduced-motion`.
- **Contraste élevé** : thème `contrast`, et sous `forced-colors` on n'utilise que les couleurs
  système. Les états ne reposent jamais sur la seule couleur : bordure, soulignement ou icône
  en plus.
- **Raccourcis** : chaque commande qui en a un l'affiche dans son infobulle et dans son menu
  (`Kbd`). Les raccourcis à une touche (outils) sont désactivables dans les Préférences
  (WCAG 2.1.4).

## Primitives

```
Button
  variants  primary, secondary, ghost, danger
  sizes     sm 28px, md 32px, lg 40px (tactile : 40 / 44 / 48)
  states    default, hover, pressed, focus-visible, disabled, loading (spinner + libellé conservé)
  tokens    primary : bg accent / text on-accent / hover accent-hover ; secondary : bg bg,
            border border-strong, text fg ; ghost : transparent, hover surface-hover ;
            danger : bg danger / text on-danger ; radius md ; font base/500
  a11y      <button> natif (RAC Button) ; en chargement : aria-busy, libellé lu, clic ignoré
  used on   S01, S04, S11–S15, toutes les boîtes de dialogue
```

```
IconButton
  variants  ghost (défaut), secondary
  sizes     sm 28px, md 32px, lg 40px ; icône 16 / 18 / 20
  states    default, hover, pressed, focus-visible, disabled
  tokens    text fg ; hover bg surface-hover ; radius md
  a11y      aria-label obligatoire (le type l'impose) ; infobulle = même libellé + raccourci
  used on   S03 (barre d'outils, onglets), S05, S06–S09, S08
```

```
ToggleButton / ToolButton
  variants  ghost ; dans une Toolbar ou un ToggleButtonGroup (sélection unique pour les outils)
  sizes     sm, md
  states    default, hover, pressed, selected (bg surface-selected + text accent-text +
            soulignement 2px accent sous l'icône, visible sans la couleur), focus-visible, disabled
  a11y      aria-pressed (bascule) ou radio dans un groupe (outil actif) ; navigation aux flèches
  used on   S03 (outils : Sélection, Main, Surligner, Note, Texte, Dessin…), S10, S13
```

```
Toolbar
  variants  horizontale (barre principale 48px, barre de propriétés 40px), verticale (rail 44px)
  states    —
  tokens    bg bg ; séparateurs border ; gap space-1
  a11y      role="toolbar" + aria-label ; une seule tabulation pour entrer, flèches pour se
            déplacer (roving tabindex, RAC Toolbar) ; Échap ramène au document
  used on   S03, S05, S11, S16 (phase 2)
```

```
DocumentTabs (TabStrip)
  variants  onglet Accueil (icône seule, fixe), onglets document
  sizes     hauteur 40px ; onglet min 120px, max 240px, titre tronqué au milieu
  states    default, hover, selected (bg bg, bordure haute 2px accent), modifié (point avant le
            bouton fermer, plus « modifié » dans le libellé accessible), focus-visible, glissé
  tokens    barre bg surface ; onglet actif bg bg ; text muted, actif fg
  a11y      RAC Tabs : role tablist / tab ; Ctrl+Tab et Ctrl+Maj+Tab ; Ctrl+W ferme ; le bouton
            fermer est hors de l'ordre de tabulation (raccourci + menu contextuel)
  used on   S01–S03
```

```
Menu / MenuButton / ContextMenu
  variants  menu déroulant, sous-menu, menu contextuel (clic droit, Maj+F10, touche Menu)
  states    item : default, hover/focus, disabled, coché (case ou radio), destructif
  tokens    bg surface-raised ; shadow pop ; radius lg ; item hauteur 32px ; raccourci text muted
  a11y      RAC Menu : role menu, flèches, saisie de la première lettre, Échap ferme et rend le focus
  used on   S01 (fichier), S03 (menu principal, page, texte, annotation, onglet), S06, S08
```

```
Select
  sizes     sm, md
  states    default, hover, focus-visible, open, disabled, invalid
  tokens    bordure border-input ; liste comme Menu
  a11y      RAC Select (bouton + listbox) ; libellé visible obligatoire
  used on   S13 (imprimante, échelle), S14
```

```
TextField / SearchField / NumberField
  variants  texte, recherche (icône loupe + bouton effacer), nombre (n° de page, zoom en %)
  sizes     sm 28px, md 32px
  states    default, hover, focus-visible (anneau focus), disabled, read-only, invalid
            (bordure danger + message danger + icône), avec description
  tokens    bg bg ; bordure border-input (3:1 vérifié) ; radius md ; placeholder text muted
  a11y      libellé toujours présent (visible ou aria-label pour la barre d'outils) ; erreur
            reliée par aria-describedby ; NumberField : flèches haut/bas, Entrée valide
  used on   S04, S05, S12, S13, S14
```

```
Checkbox / RadioGroup / Switch
  states    default, hover, focus-visible, checked, indeterminate (case), disabled, invalid
  tokens    case 16px, bordure border-input, cochée bg accent + coche on-accent ; radius sm
  a11y      éléments natifs via RAC ; la zone cliquable inclut le libellé (≥ 28px de haut)
  used on   S13, S14, S11 (cases du PDF : voir FormFieldOverlay)
```

```
Slider
  states    default, hover, focus-visible, dragging, disabled
  tokens    piste border-strong, remplissage accent, poignée 16px bg bg + bordure accent
  a11y      RAC Slider ; flèches ±1, Pg.préc / Pg.suiv ±10 ; valeur lue avec unité
  used on   S03 (opacité, épaisseur), S06 (taille des vignettes), S14
```

```
ColorSwatchPicker
  variants  couleurs d'annotation (annot-*), plus « personnalisée »
  states    default, hover, focus-visible, selected (anneau double fg + bg)
  a11y      RAC ColorSwatchPicker : chaque pastille a un nom (« Jaune », « Vert »…), jamais la couleur seule
  used on   S03 (barre de propriétés), S08
```

```
Tooltip
  states    apparition après 600ms au survol, immédiate au focus clavier ; disparaît à Échap
  tokens    bg fg (inversé) ; text bg ; font xs ; radius sm
  a11y      RAC Tooltip ; complément, jamais seule source d'information ; ne pas en mettre sur un
            élément désactivé
  used on   S03 et partout où il y a une IconButton
```

```
Dialog / AlertDialog
  sizes     sm 400px, md 560px, lg 800px ; Préférences : 860 × 600
  states    ouverture (fondu + léger zoom, motion-base), fermeture, chargement, erreur
  tokens    bg surface-raised ; voile rgba(0,0,0,.4) ; shadow pop ; radius lg ; titre xl
  a11y      RAC Modal + Dialog : focus piégé, focus initial sur le premier champ, Échap ferme
            (sauf AlertDialog destructive), focus rendu au déclencheur ; titre relié par aria-labelledby
  used on   S04 (mot de passe), S12 (signature), S13 (imprimer), S14 (préférences),
            S15 (propriétés), confirmation « Enregistrer les modifications ? »
```

```
Popover
  tokens    bg surface-raised ; shadow pop ; radius lg ; bordure border
  a11y      RAC Popover ; Échap ferme ; focus rendu au déclencheur
  used on   S03 (zoom, couleur), S08 (filtres)
```

```
Toast
  variants  info, success, error (avec action facultative : « Annuler », « Réessayer »)
  states    entrée, sortie, en pause au survol ou au focus
  tokens    bg fg / text bg (inversé) ; radius lg ; shadow pop
  a11y      région aria-live="polite" (assertive pour error) ; durée ≥ 6 s, jamais pour une
            info critique ; l'action reste accessible au clavier (F6 atteint la région)
  used on   S03 (« Enregistré », « Copié »), S01
```

```
Banner (bandeau de document)
  variants  info (formulaire remplissable, scan détecté), warning (calculs non exécutés, XFA,
            lecture seule), danger (fichier corrompu), success (signature valide)
  tokens    bg *-bg ; texte fg ; icône de la couleur du rôle ; bordure gauche 3px de la couleur
  a11y      role="status" ; actions en vrais boutons ; fermable, et ne revient pas pour ce document
  used on   S03, S11
```

```
Tree (signets)
  states    nœud : default, hover, focus-visible, selected (page courante), déplié / replié
  tokens    ligne 28px ; indentation 16px ; sélection surface-selected
  a11y      RAC Tree : role treegrid ; flèches gauche / droite déplient et replient ; * déplie tout
  used on   S07 (S09 calques en M3)
```

```
GridList (liste de fichiers, vignettes)
  variants  liste (lignes 48px), grille (cartes)
  states    item : default, hover, focus-visible, selected, favori ; liste : vide, chargement
  a11y      RAC GridList : flèches, Entrée ouvre, Espace sélectionne, actions de ligne au clavier
  used on   S01 (récents, favoris), S06 (vignettes, en virtualisé)
```

```
ProgressBar / Spinner
  variants  déterminée, indéterminée ; spinner 16 / 24px
  a11y      role progressbar, aria-valuenow si connu ; libellé (« Chargement des pages »)
  used on   S01, S03 (chargement), S13 (préparation de l'impression)
```

```
Kbd / Separator / EmptyState
  Kbd         raccourci affiché (« Ctrl F »), font mono xs, bordure border-strong, radius sm
  Separator   1px border, horizontal ou vertical (role separator, decorative dans les barres)
  EmptyState  icône Lucide 32px text muted, titre lg, phrase sm text muted, 1 bouton primaire ;
              textes écrits pour chaque cas (aucun fichier récent, aucun signet, aucun commentaire,
              aucun résultat)
  used on     S01, S05, S07, S08
```

```
Splitter (bord redimensionnable d'un panneau)
  states    default, hover (trait accent), dragging, focus-visible
  a11y      role separator + aria-valuenow ; flèches ±16px, Entrée replie / déplie ; largeur mémorisée
  used on   S06–S09 (panneau gauche), S08 (panneau droit)
```

## Composants du lecteur

```
PageCanvas
  variants  une page, deux pages, défilement continu, continu deux pages, avec couverture
  states    page : placeholder (rectangle page + numéro), rendu basse résolution, rendu net,
            erreur de rendu (message + « Réessayer ») ; document : chargement, prêt, mot de
            passe requis, corrompu
  tokens    fond canvas ; page bg page + shadow page (contraste élevé : --page-outline) ;
            espacement layout-page-gap
  a11y      conteneur role="document" avec aria-label « Page n sur N » à jour ; défilement au
            clavier (flèches, Pg.préc / Pg.suiv, Début / Fin) ; zoom Ctrl+= / Ctrl+-
  used on   S03, S10
```

```
TextLayer
  rôle      couche de texte invisible et positionnée au-dessus de chaque page, construite à partir
            des boîtes de caractères du moteur
  states    sélection (couleur système `::selection`), résultat de recherche, résultat courant
  a11y      vrai texte DOM : sélection native, copier, lecteurs d'écran ; ordre de lecture du
            balisage (StructTreeRoot) quand le PDF en a ; langue du document dans lang
  used on   S03
```

```
AnnotationLayer
  variants  surlignage, soulignement, barré, note (icône 20px), zone de texte, légende, dessin
  states    au repos, survol (contour), sélectionnée (poignées 8px + contour focus), en édition,
            verrouillée
  tokens    couleurs annot-* ; surlignage en mode multiply ; poignées bg bg + bordure accent
  a11y      chaque annotation est focusable (Tab dans l'ordre de la page) avec un nom
            (« Surlignage jaune, page 3, de Marie ») ; Suppr supprime, Entrée ouvre la note ;
            alternative clavier au glisser : flèches déplacent de 1px (Maj : 10px)
  used on   S03, S08
```

```
FormFieldOverlay
  variants  texte, multiligne, case, radio, liste, menu, signature, date
  states    vide, rempli, focus, invalide, obligatoire, lecture seule ; « champs surlignés »
            (bg info-bg) activable
  a11y      vrais contrôles HTML positionnés sur la page ; libellé = nom accessible du champ PDF
            (TU) ; Tab suit l'ordre de tabulation du PDF
  used on   S03, S11
```

```
ZoomControl
  parties   IconButton − ; NumberField % (8 à 6400) ; MenuButton (Ajuster à la page, à la largeur,
            Taille réelle, 50 %… 400 %) ; IconButton +
  a11y      groupe nommé « Zoom » ; valeur annoncée après changement (aria-live polite, en
            regroupant les changements rapides)
  used on   S03
```

```
PageNavigator
  parties   IconButton précédente ; NumberField n° de page (ou étiquette « iv ») + « sur N » ;
            IconButton suivante
  a11y      Ctrl+Maj+N place le focus dans le champ ; Entrée va à la page
  used on   S03, S06
```

```
FindBar
  parties   SearchField, compteur « 3 sur 27 », précédent / suivant, options (Casse, Mot entier,
            Ignorer les accents), fermer
  states    vide, recherche en cours (compteur « 12… »), résultats, aucun résultat (texte danger
            + phrase), document sans texte (bandeau qui annonce l'OCR à venir)
  a11y      Ctrl+F ouvre et place le focus ; Entrée / F3 suivant ; Maj+Entrée précédent ; Échap
            ferme et rend le focus au document ; le compteur est en aria-live
  used on   S05
```

```
SidePanel (gauche) + PanelRail
  parties   rail 44px de ToggleButton (Vignettes, Signets, Pièces jointes, Calques), en-tête
            (titre lg + menu), contenu, Splitter
  states    replié (rail seul), ouvert, redimensionné ; fenêtre de moins de 768px de large : tiroir par-dessus le document
  a11y      rail = Toolbar verticale ; panneau = region nommée ; F6 fait le tour
            barre d'outils → panneau → document → panneau droit
  used on   S06, S07, S09
```

```
PageThumbnail
  states    placeholder, rendue, courante (bordure 2px accent + numéro en gras), sélectionnée,
            focus-visible
  tokens    page bg page + shadow raised ; numéro xs text muted
  a11y      option de GridList nommée « Page 4 » (+ « courante ») ; Entrée va à la page
  used on   S06
```

```
CommentsPanel + CommentCard
  parties   en-tête (titre, compte, filtres, tri), liste, carte : pastille de type et couleur,
            auteur, date relative (date complète en infobulle), texte, réponses, état
  states    carte : default, survol, sélectionnée (liée à l'annotation sur la page), en édition,
            résolue (texte muted + icône) ; liste : vide, filtrée à zéro
  a11y      liste = GridList ; sélectionner une carte fait défiler jusqu'à l'annotation et
            inversement ; la carte en édition est un TextField multiligne avec Ctrl+Entrée
  used on   S08
```

```
PropertiesBar (barre de propriétés de l'outil)
  parties   ColorSwatchPicker, Slider d'opacité, épaisseur, police et taille (zone de texte)
  states    selon l'outil ; désactivée si rien n'est sélectionné
  a11y      Toolbar nommée « Propriétés de Surligner » ; changements appliqués à l'annotation
            sélectionnée
  used on   S03, S11
```

```
SignaturePad
  variants  onglets Taper (polices manuscrites libres, Caveat en OFL), Dessiner (canvas, souris,
            stylet, tactile), Image (import PNG / JPEG / SVG)
  states    vide, en cours, rempli, image trop grande, « mémoriser sur cet appareil » coché
  tokens    zone bg page, ligne de base border-strong, encre annot-black
  a11y      « Taper » est la voie entièrement au clavier (le dessin n'est pas obligatoire) ;
            boutons Effacer et Annuler ; aperçu annoncé
  used on   S12
```

```
HomeFileList (accueil)
  parties   onglets Récents / Favoris, barre (recherche, vue liste / grille), GridList, zone de
            dépôt (« Déposez un PDF ici »), bouton Ouvrir
  states    vide (premier lancement : EmptyState + raccourci Ctrl+O), rempli, fichier introuvable
            (ligne en muted + action « Rechercher » ou « Retirer »), fichier sur un lecteur réseau
            ou une clé USB déconnectés (« Emplacement indisponible »)
  a11y      la zone de dépôt a toujours un équivalent bouton
  used on   S01
```

## Icônes

Lucide (ISC). Correspondances de base : ouvrir `FolderOpen`, enregistrer `Save`, imprimer
`Printer`, rechercher `Search`, zoom `ZoomIn` / `ZoomOut`, page précédente / suivante
`ChevronUp` / `ChevronDown`, sélection `MousePointer2`, main `Hand`, surligner `Highlighter`,
note `StickyNote`, texte `Type`, dessin `PenLine`, gomme `Eraser`, signature `Signature`,
vignettes `LayoutGrid`, signets `Bookmark`, pièces jointes `Paperclip`, calques `Layers`,
commentaires `MessageSquare`, préférences `Settings`, rotation `RotateCw`, plein écran
`Maximize`, menu `Menu` / `EllipsisVertical`. Taille 16 / 18 / 20, trait 1.75.

## Ce qui change au rebranding

Seules les valeurs de `tokens.json` changent (accent, éventuellement police et rayons). Puis on
relance `build-tokens.py` et `check-contrast.py`. Les composants ne bougent pas.
