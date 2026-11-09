# Recon map : Adobe Acrobat Reader + outils Acrobat Pro (Desktop + Web)

Périmètre : le lecteur gratuit (ouvrir, naviguer, rechercher, annoter, remplir et signer, imprimer)
plus les outils payants de Standard/Pro (modifier, organiser, combiner, convertir, compresser,
protéger, OCR, caviarder, comparer, formulaires, signatures numériques, partage et demandes de signature).
Plateforme : **desktop uniquement** (Windows d'abord, macOS et Linux plus tard), installé par un
fichier setup. Pas de version navigateur.
Pour : tout le monde. Une application **entièrement gratuite et accessible à tous** : sans
abonnement, sans licence, sans compte, sans publicité, sans serveur, accessible (WCAG 2.2 AA).
Code source fermé (gratuit, mais pas open source).
Date : 2026-11-09

> **Révision du 2026-11-09 : application gratuite.** Les écrans et parcours liés au compte, au
> paiement ou à un serveur sont abandonnés : S29 Partager, S30 Demander des signatures, S31 Compte
> et offre payante, S33 Vue relecteur, S34 Assistant IA ; F19, F20, F23. Ils restent listés plus bas
> pour mémoire, marqués *(abandonné)*. Tous les outils « payants » d'Acrobat seront gratuits et
> traités localement sur l'appareil.
>
> **Révision : desktop uniquement.** Pas de version navigateur : S32 (page outil web) et F22 sont
> abandonnés. L'application s'installe avec un fichier setup (`PDFReader-Setup.exe`).

> Clean-room. Cette carte décrit des fonctions et des parcours, à partir de pages publiques
> uniquement. Aucun code, aucune ressource graphique, aucun texte d'Adobe ne doit entrer dans le clone.

## Règles et conditions d'utilisation (à lire avant de construire)

- **Conditions générales d'Adobe, section 17** (https://www.adobe.com/legal/terms.html, en vigueur au 3 oct. 2025) :
  interdiction de faire de la rétro-ingénierie, y compris en observant les entrées et les sorties
  d'un service pour le recréer, et de décompiler. Section 6.5 : pas de jeu de données construit
  à partir de contenus Adobe à des fins de rétro-ingénierie.
  **Conséquence** : on travaille uniquement à partir de la documentation publique et de la norme
  ISO. On ne fait pas tourner Acrobat sur des lots de fichiers pour comparer ses sorties
  (conversion, OCR, compression) dans le but de les reproduire. Les fichiers de test viennent de
  corpus publics et de nos propres documents, et on mesure le clone contre la norme, pas contre Adobe.
- **Licence d'Acrobat Reader** (https://www.adobe.com/go/reader-eula) : PDF non lu pendant cette
  recon. À lire avant toute comparaison manuelle avec un Reader installé.
- **Marques** (https://www.adobe.com/legal/permissions/trademarks.html) : interdits dans le nom, le
  logo ou le marketing : « Adobe », « Acrobat », l'icône rouge, toute suggestion de partenariat.
  « PDF » n'apparaît pas comme marque Adobe sur cette page et des concurrents l'utilisent dans leur
  nom (lecteurs « PDF Reader » de Foxit, Xodo…). À vérifier dans la base de marques pendant `/replica-brand`.
- **Le format est ouvert** : PDF 2.0 = ISO 32000-2, téléchargeable gratuitement auprès de la
  PDF Association (accès sponsorisé depuis avril 2023, bundle errata 2 de juillet 2024).
  C'est la vraie source du modèle de données : annotations, formulaires, signets, signatures,
  chiffrement y sont tous définis.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | Aide Acrobat desktop (sommaire complet) | https://helpx.adobe.com/acrobat/desktop.html | ~400 articles. Leur sommaire est la liste de fonctions la plus complète. Lu dans le navigateur, sans copie. |
| 2 | Workspace basics | https://helpx.adobe.com/acrobat/desktop/get-started/learn-the-basics/workspace.html | 3 vues (Accueil, Tous les outils, Document), barre globale, panneau droit, barre d'actions rapides. Mis à jour le 9 sept. 2026. |
| 3 | Navigation dans les pages | https://helpx.adobe.com/acrobat/desktop/get-started/learn-the-basics/navigation.html | page suivante/précédente, aller à, vue précédente, défilement auto, articles |
| 4 | Raccourcis clavier | https://helpx.adobe.com/acrobat/desktop/get-started/preferences-and-settings/keyboard-shortcuts.html | carte complète des raccourcis (outils, commentaires, navigation, formulaires) |
| 5 | Acrobat sur le web, présentation | https://helpx.adobe.com/acrobat/web/get-set-up/learn-the-basics/overview.html | fonctions web, panneau Lire (IA), AES-256 / TLS 1.2 |
| 6 | Tarifs | https://www.adobe.com/acrobat/pricing.html | Reader gratuit ; Standard 14,99 $/mois ; Pro 19,99 $/mois ; Studio (Pro + IA) 24,99 $/mois (annuel facturé au mois, US) |
| 7 | Fonctions par offre | https://www.adobe.com/acrobat/features.html | quelles fonctions sont payantes (édition, conversion, OCR, caviardage, comparaison) |
| 8 | Page Reader | https://www.adobe.com/acrobat/pdf-reader.html | le discours du gratuit : voir, imprimer, annoter, remplir et signer, partager |
| 9 | Notes de version desktop | https://helpx.adobe.com/acrobat/desktop/whats-new/release-notes.html | 2026 : IA partout (édition par chat, podcasts, présentations, PDF Spaces, pages de couverture) |
| 10 | Notes de version mobile | https://helpx.adobe.com/acrobat/mobile/whats-new/release-notes-mobile.html | parité mobile, onglet Creations |
| 11 | Conditions générales Adobe | https://www.adobe.com/legal/terms.html | §6, §17 (voir plus haut) |
| 12 | Règles de marques Adobe | https://www.adobe.com/legal/permissions/trademarks.html | voir plus haut |
| 13 | ISO 32000-2 (PDF 2.0), gratuit | https://pdfa.org/announcing-no-cost-access-to-iso-32000-2-pdf-2-0/ | modèle de données normatif |
| 14 | Compte de l'utilisateur | — | non utilisé. Si tu as Reader installé, fais toi-même les captures listées en fin de document. |

## Boucle cœur

Ouvrir un PDF, le lire, le marquer (surligner, commenter, remplir, signer) et l'enregistrer.
Chez Adobe, **modifier le PDF lui-même** (texte, pages, conversion, compression, OCR, caviardage)
est payant. Chez nous, tout est gratuit : c'est notre différence principale, avec la légèreté et la
confidentialité (rien n'est envoyé).

## Écrans

Les vues desktop et web partagent les mêmes écrans sauf mention. « Outil » = panneau gauche
ouvert depuis « Tous les outils », avec le document au centre.

| ID | écran | accès | rôle | composants clés | états vus / à prévoir |
| --- | --- | --- | --- | --- | --- |
| S01 | Accueil | au lancement ; bouton Accueil de la barre d'onglets | fichiers récents, favoris, fichiers cloud, accords, outils recommandés | TopBar, onglets Récents / Favoris / Fichiers / Accords, FileList (liste ou vignettes), filtre (partagés par moi, avec moi, locaux), panneau « Détails rapides », recherche, notifications, menu compte | vide (1er lancement), rempli, non connecté, hors ligne, chargement cloud |
| S02 | Tous les outils | bouton « Tous les outils » de la barre globale | catalogue des outils par catégorie | ToolCard groupées (Créer, Modifier, Convertir, Signer, Protéger, Organiser…), badge Pro | gratuit (outils payants verrouillés), payant, recherche d'outil |
| S03 | Vue document | double-clic sur un .pdf, Ouvrir, glisser-déposer, clic dans S01 | lire et travailler un PDF, un onglet par fichier | TabStrip (+ flèches si débordement), GlobalBar (Tous les outils, Modifier, Convertir, Signer, Rechercher, Enregistrer, Imprimer, Partager), QuickActionToolbar flottante, PageCanvas, RightPanel (rail d'icônes), ZoomControl, PageNavigator, rotation, réglages d'affichage | chargement progressif, rempli, fichier corrompu, mot de passe requis (S04), bandeau Vue protégée, bandeau « formulaire remplissable », bandeau « document signé / certifié », lecture seule (droits restreints), modifications non enregistrées (point sur l'onglet), PDF très lourd (1000+ pages) |
| S04 | Mot de passe à l'ouverture | ouverture d'un PDF chiffré | saisir le mot de passe utilisateur | PasswordDialog | vide, erreur « mot de passe incorrect », annulation |
| S05 | Recherche | Ctrl+F ; loupe de la barre globale | trouver du texte, résultat suivant/précédent | FindBar (champ, compteur, préc./suiv.), recherche avancée (casse, mot entier, commentaires, signets, plusieurs PDF d'un dossier), liste de résultats | aucun résultat, en cours, résultats, PDF sans texte (scan : suggérer l'OCR) |
| S06 | Panneau Vignettes | rail droit | voir et parcourir les pages | PageThumbnail virtualisée, page courante surlignée, menu contextuel (pivoter, supprimer, insérer, extraire) | chargement, rempli, sélection multiple |
| S07 | Panneau Signets | rail droit | table des matières du PDF | Tree (déplier, replier, tout déplier), ajouter / renommer / supprimer un signet | vide (« aucun signet »), rempli |
| S08 | Panneau Commentaires | rail droit ; ouvrir un commentaire | lister, filtrer, répondre, résoudre | CommentCard (auteur, date, texte, réponses, réactions), filtres (type, auteur, statut, couleur), tri, recherche, case « coché » | vide, rempli, filtré à zéro, non lus |
| S09 | Autres panneaux | rail droit (personnalisable) | Pièces jointes, Calques, Articles, Propriétés de la sélection | listes simples, bascule de visibilité des calques | vide, rempli |
| S10 | Lecture / plein écran | menu Affichage ; Échap pour sortir | lire sans interface | PageCanvas seul, contrôles discrets | plein écran, mode lecture, défilement automatique |
| S11 | Remplir et signer | barre d'actions rapides ; Signer > Remplir et signer | remplir un formulaire (avec ou sans champs) et signer | détection des champs, champ texte libre, coche, croix, point, date, initiales, bouton Signer | formulaire avec champs (AcroForm), formulaire plat (sans champs), XFA (non pris en charge), champs obligatoires manquants |
| S12 | Créer une signature | S11 > Signer > Ajouter une signature | créer sa signature et ses initiales | SignaturePad, onglets Taper / Dessiner / Image, choix du style, case « enregistrer la signature » | vide, rempli, image trop grande, signature enregistrée réutilisable |
| S13 | Imprimer | Ctrl+P ; icône Imprimer | imprimer | aperçu, imprimante, pages (toutes, courante, plage, sous-ensemble pair/impair), échelle (ajuster, taille réelle, réduire, plusieurs pages par feuille, livret, affiche), recto-verso, orientation, commentaires et formulaires (document, document + annotations, champs seuls) | aperçu, aucune imprimante, impression en cours, erreur |
| S14 | Préférences | Menu > Préférences (Ctrl+K) | réglages de l'app | dialogue à catégories (Général, Affichage de page, Documents, Commentaires, Formulaires, Signatures, Sécurité / sécurité renforcée, Recherche, Accessibilité, Langue, Mises à jour, thème clair / sombre) | défaut, modifié, restauration |
| S15 | Propriétés du document | Menu > Propriétés du document (Ctrl+D) | métadonnées, sécurité, polices, affichage initial | onglets Description / Sécurité / Polices / Affichage initial / Personnalisé / Avancé | lecture seule (gratuit), modifiable (payant) |
| S16 | Organiser les pages | Tous les outils > Organiser | réordonner, pivoter, supprimer, insérer, extraire, remplacer, diviser, rogner, renuméroter | grille de PageThumbnail avec glisser-déposer, barre d'outils de l'outil, curseur de taille | sélection multiple, glisser en cours, PDF protégé (refus), annulation |
| S17 | Combiner des fichiers | Tous les outils > Combiner | fusionner plusieurs fichiers en un PDF | Dropzone, liste de fichiers réordonnable (vignettes / liste), options (signets par fichier, taille), bouton Combiner | vide, rempli, type non pris en charge, conversion en cours, terminé (ouvre S03) |
| S18 | Modifier le PDF | barre globale > Modifier | modifier texte et images en place, ajouter liens, en-têtes, filigranes | boîtes de texte éditables, panneau gauche (police, taille, couleur, alignement, listes), outils image (remplacer, rogner, pivoter), correcteur | police non disponible (substitution), texte en contours (non éditable), scan (proposer l'OCR) |
| S19 | Exporter / Convertir | barre globale > Convertir | PDF vers Word, Excel, PowerPoint, image, texte, RTF, HTML | choix du format et des options, ProgressBar | en cours, succès (ouvrir le fichier), échec, PDF scanné (OCR auto) |
| S20 | Créer un PDF | bouton Créer de l'Accueil ; Tous les outils > Créer | depuis un fichier, plusieurs fichiers, scanner, presse-papiers, page web, page blanche | Dropzone, choix de la source, options | format non pris en charge, en cours, terminé |
| S21 | Compresser / optimiser | Tous les outils > Compresser | réduire la taille | niveaux (élevé, moyen, faible), avancé (images, polices, nettoyage), audit de l'espace utilisé | avant / après (taille), déjà optimisé |
| S22 | Protéger | Tous les outils > Protéger | mot de passe d'ouverture, restrictions (impression, copie, modification), chiffrement | formulaire mots de passe + jauge de robustesse, choix de compatibilité / algorithme | faible, confirmé, document déjà protégé |
| S23 | Caviarder (Pro) | Tous les outils > Caviarder | supprimer définitivement texte et images, nettoyer le document | marquer zone / texte, rechercher et caviarder (mots, motifs : e-mail, téléphone, numéros), apparence, codes, Appliquer, Nettoyer (métadonnées, calques, texte caché) | marques non appliquées, appliquées (irréversible), nettoyé |
| S24 | Comparer des fichiers (Pro) | Tous les outils > Comparer | différences entre deux versions | choix des deux fichiers, vue côte à côte synchronisée, résumé des changements (texte, images, mise en page), filtres | identiques, différences, fichiers trop différents |
| S25 | Numériser et OCR (Pro) | Tous les outils > Numériser et OCR | rendre un scan cherchable / éditable | source (scanner, fichier), langue, sortie (image cherchable, texte éditable), corriger le texte suspect, redresser, améliorer | sans texte, en cours, terminé, suspects à revoir |
| S26 | Préparer un formulaire | Tous les outils > Préparer un formulaire (A) | créer des champs | détection auto des champs, palette (texte, case, radio, liste, menu, bouton, signature, code-barres), propriétés de champ (format, validation, calcul), aligner, ordre de tabulation, aperçu (P) | détection, édition, aperçu |
| S27 | Améliorer les pages | Tous les outils > Modifier / Organiser | filigrane, arrière-plan, en-tête / pied, numéros de page, Bates (Pro) | dialogue avec aperçu, macros (page, date, n° Bates), appliquer à plusieurs fichiers | ajout, mise à jour, suppression |
| S28 | Certificats et signature numérique | Tous les outils > Utiliser un certificat | signer avec une ID numérique, certifier, horodater, valider | liste des ID numériques, création d'ID auto-signée, apparence de la signature, panneau Signatures (état de validité), réglages de confiance | valide, inconnue, invalide (document modifié après signature), révoquée |
| S29 | Partager *(abandonné)* | bouton Partager | lien de lecture ou de relecture, e-mail, gérer l'accès | ShareDialog (destinataires, droit commenter ou voir, date limite, lien copiable), suivi des vues | non connecté (demande de compte), lien créé, accès révoqué |
| S30 | Demander des signatures / Accords *(abandonné)* | Signer > Demander des signatures ; onglet Accords | envoyer à des signataires, placer les champs, suivre | liste des signataires et ordre, placement des champs par signataire, message, liste d'accords (statuts), rappels | brouillon, envoyé, en attente, signé, annulé, expiré |
| S31 | Compte et offre payante *(abandonné)* | menu compte ; clic sur un outil verrouillé | se connecter, s'abonner, gérer l'offre | modale d'upsell (comparatif des offres), connexion, page de paiement, gérer l'abonnement | non connecté, gratuit, essai, payant, paiement échoué |
| S32 | Web : page outil avec dépôt *(abandonné)* | URL publique d'un outil (/compresser, /pdf-vers-word…) | utiliser un outil sans installer | Dropzone, sélection depuis le cloud, progression, téléchargement du résultat | vide, upload, traitement, résultat, limite gratuite atteinte, fichier trop gros |
| S33 | Web : vue relecteur d'un lien partagé *(abandonné)* | lien reçu par e-mail | lire et commenter sans compte | S03 simplifié, demande de nom pour commenter | lien valide, expiré, accès refusé |
| S34 | Assistant IA *(abandonné)* | bouton IA / panneau Lire | résumé, questions-réponses avec citations | panneau de chat, citations cliquables vers la page | non activé (upsell), en cours, réponse, document trop long |
| S35 | Mises à jour et À propos | Menu > Aide | version, recherche de mise à jour, notes de version | dialogue simple | à jour, mise à jour dispo, téléchargement, redémarrage |

## Parcours

```
F01 Ouvrir et lire un PDF local (desktop)
    explorateur (.pdf associé) -> S03
    clics chemin heureux : 1 (double-clic)  |  depuis l'app : S01 > Ouvrir > fichier = 3
    edge : fichier corrompu, mot de passe (F21), PDF de 2 Go, fichier déjà ouvert (focus sur l'onglet),
           fichier verrouillé par une autre app, JavaScript dans le PDF (bandeau sécurité)

F02 Rechercher un mot
    S03 -> Ctrl+F -> S05 -> Entrée / F3 pour suivant
    clics : 0 (clavier) ou 1
    edge : aucun résultat, PDF scanné sans texte, ligatures et césures, langues RTL / CJK

F03 Surligner et commenter
    S03 -> outil Surligner (barre rapide) -> sélection de texte -> note -> S08
    clics : 3
    edge : texte non sélectionnable (scan), couleur changée, réponse à un commentaire, résoudre,
           enregistrer dans le fichier (annotations dans /Annots, lisibles par tout lecteur)

F04 Remplir et signer un formulaire
    S03 -> Remplir et signer (S11) -> remplir les champs -> Signer -> S12 (1re fois) -> placer -> Enregistrer
    clics : 6 (1re fois), 4 ensuite (signature mémorisée)
    edge : formulaire plat sans champs, XFA, calculs entre champs, champ obligatoire vide,
           le PDF interdit la sauvegarde (droits d'usage)

F05 Enregistrer / Enregistrer sous
    S03 -> Ctrl+S (sauvegarde incrémentale) | Ctrl+Maj+S -> dialogue système
    clics : 0-2
    edge : fichier en lecture seule, disque plein, document signé (une sauvegarde complète
           invaliderait la signature : sauvegarde incrémentale obligatoire), fermeture avec modifications

F06 Imprimer
    S03 -> Ctrl+P -> S13 -> Imprimer
    clics : 1
    edge : formats de page mixtes, livret, plusieurs pages par feuille, imprimer les commentaires,
           impression interdite par les permissions du PDF

F07 Organiser les pages (payant)
    S02 -> Organiser -> S16 -> glisser / pivoter / supprimer / insérer -> Enregistrer
    clics : 5
    edge : annuler / rétablir, insertion d'un autre PDF, pages de tailles différentes, signets et liens
           qui pointent vers des pages supprimées

F08 Combiner des fichiers (payant)
    S01 ou S02 -> Combiner -> S17 -> ajouter des fichiers -> réordonner -> Combiner -> S03
    clics : 5
    edge : fichier Word ou image (conversion préalable), PDF protégé, formulaires avec des noms de champs
           identiques, signets à fusionner

F09 Modifier du texte (payant)
    S03 -> Modifier -> S18 -> clic dans le texte -> taper -> Ctrl+S
    clics : 3
    edge : police non embarquée ou sous-ensemble, texte vectorisé, reflow sur plusieurs lignes,
           colonnes, langues RTL

F10 Exporter vers Word (payant)
    S03 -> Convertir -> S19 -> Word -> Exporter -> dialogue d'enregistrement
    clics : 4
    edge : scan (OCR auto), tableaux, multi-colonnes, polices manquantes

F11 Créer un PDF depuis un fichier (payant)
    S01 -> Créer -> S20 -> choisir un fichier -> Créer -> S03
    clics : 3
    edge : formats Office, images multiples, HTML, fichier très lourd

F12 Compresser (payant)
    S02 -> Compresser -> S21 -> niveau -> Compresser -> enregistrer
    clics : 4
    edge : déjà optimisé (gain nul), images JBIG2 / JPX, perte de qualité visible

F13 Protéger par mot de passe (payant)
    S02 -> Protéger -> S22 -> mot de passe x2 -> Appliquer -> Enregistrer
    clics : 4
    edge : mot de passe faible, permissions sans mot de passe d'ouverture, compatibilité anciens lecteurs

F14 Caviarder (Pro)
    S02 -> Caviarder -> S23 -> marquer ou rechercher -> Appliquer -> Nettoyer -> Enregistrer sous
    clics : 6
    edge : le texte caviardé doit disparaître du flux (pas juste un rectangle noir), images partielles,
           métadonnées, calques cachés, annotations

F15 Comparer deux versions (Pro)
    S02 -> Comparer -> S24 -> choisir ancien et nouveau -> Comparer -> parcourir le résumé
    clics : 4
    edge : pages insérées ou supprimées, documents scannés, mise en page changée

F16 OCR d'un scan (Pro)
    S03 (bandeau « ce document semble scanné ») -> S25 -> langue -> Reconnaître -> corriger -> Enregistrer
    clics : 4
    edge : pages inclinées, plusieurs langues, mauvaise qualité, très gros volume

F17 Créer un formulaire (payant)
    S02 -> Préparer un formulaire -> S26 (détection auto) -> ajuster les champs -> Aperçu -> Enregistrer
    clics : 5
    edge : champs mal détectés, calculs, validation, ordre de tabulation

F18 Signer avec un certificat et valider
    S28 -> choisir une zone -> choisir une ID numérique -> apparence -> Signer -> Enregistrer sous
    clics : 5 ; validation : ouvrir un PDF signé -> bandeau -> panneau Signatures
    edge : pas d'ID (en créer une auto-signée), certificat expiré ou révoqué, document modifié après signature,
           horodatage, chaîne de confiance inconnue

F19 Partager pour relecture (abandonné)
    S03 -> Partager -> S29 -> e-mails + « peut commenter » -> Envoyer
    le relecteur : e-mail -> S33 -> commente -> l'auteur voit les commentaires dans S08
    clics : 3 (auteur), 2 (relecteur)
    edge : lien expiré, accès révoqué, relecteur sans compte, conflits de commentaires

F20 Demander une signature (abandonné)
    S03 -> Signer > Demander des signatures -> S30 -> signataires + ordre -> placer les champs -> Envoyer
    le signataire : e-mail -> page de signature -> signe ; l'expéditeur suit dans S30
    clics : 6
    edge : signataire refuse, rappel, expiration, ordre séquentiel ou parallèle, piste d'audit

F21 Ouvrir un PDF protégé
    S03 -> S04 -> mot de passe -> S03
    clics : 1 + saisie
    edge : mot de passe faux, PDF chiffré par certificat, permissions restreintes (impression, copie)

F22 Web : utiliser un outil sans installer (abandonné : desktop uniquement)
    S32 -> déposer le fichier -> traitement -> télécharger (ou ouvrir dans S03 web)
    clics : 2
    edge : fichier trop gros pour la mémoire du navigateur, navigateur sans File System Access
           (enregistrement = téléchargement d'une copie). Le traitement est local : aucun envoi.

F23 Passer à l'offre payante (abandonné : appli gratuite)
    clic sur un outil verrouillé -> S31 modale -> choisir l'offre -> paiement -> outil déverrouillé
    clics : 4
    edge : paiement refusé, essai gratuit, licence desktop hors ligne, remboursement
```

## Composants

| composant | variantes | états | utilisé sur |
| --- | --- | --- | --- |
| Button | primaire, secondaire, ghost, danger, icône seule | défaut, survol, focus, désactivé, chargement | tous |
| TopBar + TabStrip | Accueil, Tous les outils, onglets document, flèches de débordement | actif, non enregistré (point), fermeture | S01–S03 |
| GlobalBar | outils (Tous les outils, Modifier, Convertir, Signer) + actions (Rechercher, Enregistrer, Imprimer, Partager) | actif, désactivé, verrouillé Pro | S03 |
| QuickActionToolbar | flottante, verticale, personnalisable | outil actif, sous-menu (couleur, épaisseur), masquée | S03 |
| ToolPanel (panneau gauche d'un outil) | un par outil | ouvert, fermé, étapes | S11, S16–S28 |
| RightPanel | rail d'icônes + contenu (Vignettes, Signets, Commentaires, Pièces jointes, Calques, Articles) | replié, ouvert, personnalisé | S03, S06–S09 |
| PageCanvas | une page, deux pages, défilement continu, couverture | chargement par page, rendu, zoom, sélection de texte, focus clavier | S03, S10, S18, S24 |
| PageThumbnail | petite, moyenne, grande | courante, sélectionnée, glissée, chargement | S06, S16, S17 |
| ZoomControl | +/−, valeur %, ajuster la page / la largeur / la hauteur / le contenu, zoom de zone, loupe | — | S03 |
| PageNavigator | n / total, préc./suiv., première / dernière | saisie invalide | S03, S06 |
| FindBar | simple, avancée | vide, résultats, aucun résultat | S05 |
| Annotation | surlignage, souligné, barré, note, zone de texte, légende, rectangle, ellipse, ligne, flèche, polygone, nuage, crayon, gomme, tampon, pièce jointe | création, sélection (poignées), édition, verrouillée | S03, S08 |
| AnnotationProperties | couleur, opacité, épaisseur, police | — | S03 |
| CommentCard | commentaire, réponse | lu, non lu, résolu, coché, réaction | S08, S33 |
| SignaturePad | taper, dessiner, image | vide, rempli, enregistré | S12 |
| FormField (remplissage) | texte, multiligne, case, radio, liste, menu, bouton, signature, date | vide, rempli, invalide, obligatoire, lecture seule, focus | S03, S11 |
| FormFieldEditor (création) | les mêmes + code-barres | sélectionné, multiple, guides | S26 |
| Dropzone | plein écran, en ligne | vide, survol, upload, erreur | S17, S20, S32 |
| FileList | liste, vignettes | vide, chargement, sélection, favori | S01 |
| Modal / Dialog | simple, à onglets, à catégories (Préférences) | ouvert, erreur | S04, S12–S15, S29, S31 |
| Toast | info, succès, erreur | apparition, auto-fermeture | tous |
| Banner (bandeau document) | vue protégée, formulaire remplissable, document signé, scan détecté (OCR), lecture seule | — | S03 |
| ContextMenu | page, texte, annotation, onglet | — | S03, S06, S16 |
| Tree | signets, calques | déplié, replié, édition du titre | S07, S09 |
| ProgressBar | déterminée, indéterminée | en cours, terminé, échec | S17, S19–S25, S32 |
| ProBadge / UpsellModal | badge sur un outil, modale comparative | — | S02, S31 |
| ColorPicker | palette, personnalisée | — | S03, S18, S23 |
| Tooltip, Input, Select, Checkbox, Radio, Slider | standard | défaut, focus, erreur, désactivé | tous |
| SideBySideViewer | défilement synchronisé, surlignage des différences | — | S24 |

## Modèle de données inféré

Deux couches. **(a) Le contenu du PDF** est défini par ISO 32000-2 : on ne l'invente pas, on le lit
et on l'écrit (annotations, champs, signets, signatures, chiffrement vivent dans le fichier, et c'est
ce qui rend le clone compatible avec tous les lecteurs). **(b) Les données de l'app** (comptes, récents,
partage, accords, préférences) sont à nous.

```
(a) Dans le fichier PDF (norme ISO 32000-2, confiance : high)

Document     pages[], info (titre, auteur, sujet, mots-clés, dates), metadata XMP, version PDF,
             encrypt (filtre, algorithme AES-128/256, permissions P), outlines, acroform, embedded_files,
             ocgs (calques), threads (articles), page_labels
             evidence: S15 propriétés, S22 protéger, ISO 32000-2 §7.5, §12

Page         index, mediabox, cropbox, rotate (0|90|180|270), resources, content_streams, annots[]
             evidence: S16 organiser (pivoter, rogner), ISO 32000-2 §7.7.3

Annotation   subtype (Highlight | Underline | StrikeOut | Squiggly | Text | FreeText | Line | Square |
             Circle | Polygon | PolyLine | Ink | Stamp | FileAttachment | Link | Redact | Widget),
             page, rect, quad_points, color, opacity (CA), border, author (T), contents, subject,
             created, modified (M), in_reply_to (IRT), state (Review : Accepted | Rejected | Cancelled |
             Completed ; Marked : Marked | Unmarked), flags (locked, hidden, print)
             evidence: S08, raccourcis « commentaires », ISO 32000-2 §12.5

FormField    full_name, type (Tx | Btn [case, radio, bouton] | Ch [liste, menu] | Sig), value, default,
             flags (obligatoire, lecture seule, multiligne), format / validate / calculate (JavaScript),
             widgets[] (un par apparition à l'écran)
             evidence: S11, S26, articles « Field formatting », « calculations », ISO 32000-2 §12.7

Bookmark     title, destination (page + vue) ou action, children[], open, color, style
             evidence: S07, ISO 32000-2 §12.3.3

DigitalSignature  field, signer (certificat), signing_time, reason, location, byte_range,
             subfilter (PAdES : ETSI.CAdES.detached), timestamp, dss (validation à long terme),
             certification (DocMDP : niveau de modifications permis)
             evidence: S28, articles « Certify PDFs », « Validate digital signatures », ISO 32000-2 §12.8

(b) Données de l'app (à concevoir dans /replica-architect)

User         id, email, nom affiché (auteur des commentaires), plan, created_at
             evidence: S31, article « Change author name on comments »
             confidence: high

Subscription user_id, plan (free | standard | pro), status (trial | active | past_due | cancelled),
             period_end, provider_ref
             evidence: page tarifs, S31
             confidence: high

RecentFile   user_id (ou local), path ou cloud_file_id, name, size, page_count, last_opened_at,
             last_page, last_zoom, starred, thumbnail
             evidence: S01 Récents / Favoris ; « restaurer la dernière vue » à l'ouverture
             confidence: high (récents, favoris) / medium (dernière page et zoom)

CloudFile    id, owner_id, name, storage_key, size, mime, version, folder (documents | scans),
             created_at, updated_at
             evidence: S01 Fichiers (« Vos documents », « Numérisations »)
             confidence: high

Share        id, file_id, created_by, link_token, permission (view | comment), deadline, revoked_at
ShareRecipient share_id, email, viewed_at, last_activity_at
             evidence: S29, articles « Manage access », « Track shared PDF reviews »
             confidence: medium

ReviewComment  synchronisé avec les annotations du fichier pour la relecture en ligne,
             + reactions[] (emoji, user), read_by[]
             evidence: articles « Add reactions to comments », « Mark comments as unread or resolved »
             confidence: medium (les réactions et le statut lu / non lu ne sont pas dans la norme)

SavedSignature user_id, kind (signature | initials), method (typed | drawn | image), svg_or_png, font
             evidence: S12
             confidence: high

DigitalId    user_id, label, certificate (public), storage (fichier PKCS#12 local | magasin Windows |
             cloud), is_default
             evidence: S28, articles « Digital ID overview », « Set a default digital ID »
             confidence: high

Agreement    id, sender_id, file_id, name, message, status (draft | out_for_signature | signed |
             declined | cancelled | expired), order (sequential | parallel), expires_at
AgreementParticipant  agreement_id, email, role (signer | approver | cc), order, status, signed_at
AgreementEvent  agreement_id, type (sent | viewed | signed | declined | reminded), actor, at, ip
             evidence: S30, articles « Manage agreements », « Request e-signatures in bulk »
             confidence: high (statuts) / guess (champs exacts de la piste d'audit)

CustomStamp  user_id, name, category, image, dynamic_fields (date, nom)
             evidence: articles « Create custom stamps », « Create custom dynamic stamps »
             confidence: high

Preferences  user_id ou local, clé / valeur (thème, unités, affichage de page, vue protégée,
             accélérateurs à touche unique, nom d'auteur…)
             evidence: S14
             confidence: high

ProcessingJob  id, user_id, tool (convert | ocr | compress | combine | compare), input_ids[],
             output_id, status (queued | running | done | failed), error, created_at, expires_at
             evidence: S32 (traitement côté serveur sur le web)
             confidence: guess (le desktop peut tout faire en local)
```

Relations : User 1-n RecentFile, User 1-n CloudFile, CloudFile 1-n Share, Share 1-n ShareRecipient,
CloudFile 1-n ReviewComment, User 1-n SavedSignature, User 1-n DigitalId, User 1-n Agreement,
Agreement 1-n AgreementParticipant, Agreement 1-n AgreementEvent, User 1-1 Subscription,
User 1-n CustomStamp. Dans le fichier : Document 1-n Page, Page 1-n Annotation,
Document 1-n FormField, FormField 1-n Widget (Annotation), Document 1-n Bookmark (arbre).

## Matrice de fonctions

Voir `features.csv`. Must : 54, should : 38, could : 25, skip : 26 (143 lignes, après les révisions « gratuite », « code fermé », « desktop uniquement » et « zéro coût pour l'éditeur »).

## Hors périmètre (ne peut pas ou ne doit pas être cloné)

- **La marque** : nom, logo, icône rouge, police Adobe Clean, textes de l'interface et de l'aide.
- **Adobe Approved Trust List (AATL)** : la liste de certificats de confiance intégrée à Acrobat.
  C'est un programme de partenariat. Notre clone validera avec le magasin de certificats du système
  et l'EUTL (liste de confiance européenne), pas avec l'AATL.
- **Valeur juridique d'Acrobat Sign** : conformité eIDAS qualifiée, partenaires prestataires de
  confiance, certifications. On peut construire des signatures électroniques simples et avancées ;
  la signature qualifiée passe par un prestataire de confiance (QTSP) sous contrat.
- **Adobe Express, Firefly, podcasts et pages de couverture** : ce sont d'autres produits Adobe.
- **Intégrations entreprise propriétaires** : Microsoft Purview (MPIP), politiques de sécurité serveur Adobe, Adobe Experience Manager.
- **Formulaires XFA dynamiques** : technologie propriétaire, abandonnée dans PDF 2.0.
- **Le cloud Adobe et ses utilisateurs** : on construit notre propre stockage ; on ne récupère pas le réseau d'Adobe.
- **Base de polices Adobe** : polices sous licence ; on utilise des polices libres (Noto, Liberation…) pour la substitution.

## Taille

Écrans 35, parcours 23, entités 17 (5 dans le fichier, 12 dans l'app).

Parties difficiles :
1. **Moteur de rendu** fidèle et rapide (polices, transparence, gros fichiers) sur desktop et web.
   À ne pas écrire soi-même : PDFium (BSD) ou PDF.js (Apache 2.0). Attention, MuPDF et Ghostscript
   sont sous AGPL : il faut une licence commerciale pour un produit vendu en code fermé.
2. **Édition de texte dans le PDF** : retoucher des flux de contenu avec des polices en sous-ensemble,
   faire couler le texte sur plusieurs lignes. C'est la fonction payante phare, et la plus dure techniquement.
3. **Conversions** PDF vers Office (tableaux, colonnes) et Office vers PDF (il faut un moteur Office :
   LibreOffice en mode serveur, ou un SDK commercial).
4. **OCR, caviardage réel et comparaison** : Tesseract pour l'OCR ; un caviardage qui retire vraiment
   le contenu du flux ; un diff de texte et de mise en page.
5. **Signatures numériques** PAdES (validation à long terme, horodatage) et chaîne de confiance.
6. **Un cœur pour deux plateformes** : le même moteur en natif sur desktop et en WebAssembly sur le web,
   avec la parité des fonctions et le traitement local des fichiers confidentiels.

**Taille : XL, à redécouper.** Le périmètre complet représente plusieurs trimestres. Découpage proposé :

| phase | contenu | taille |
| --- | --- | --- |
| 1. Lecteur | S01–S15 : ouvrir, lire, rechercher, annoter, remplir et signer, imprimer, enregistrer. Desktop, installé par setup. Sans compte. | L (un trimestre) |
| 2. Outils, premier lot (payants chez Adobe, gratuits ici) | organiser, combiner, compresser, protéger, créer un PDF depuis une image, exporter en image / texte | M |
| 3. Outils, second lot | modifier le texte, convertir vers / depuis Office (en local), OCR | L |
| 4. Outils avancés | caviarder, comparer, préparer un formulaire, signatures numériques | L |

## Captures à faire (référence, jamais livrées)

Rien n'a été capturé pendant cette recon : aucun compte n'a été utilisé et Reader n'a pas été piloté.
Si Reader est installé sur ta machine, fais ces captures toi-même et range-les dans `replica/screens/`
sous le nom `S03-filled.png`, `S01-empty.png`, etc. :
S01 vide et rempli, S02, S03 (rempli, mot de passe, formulaire), S05 avec résultats, S06, S07, S08,
S11, S12, S13, S14 (2 ou 3 catégories), S16, S31 (modale d'upsell sur un outil verrouillé).
