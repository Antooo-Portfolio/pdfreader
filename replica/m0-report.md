# Spike M0 : moteur PDF natif — rapport

Date : 2026-11-09 · Machine : Windows 11 Pro, WebView2 157 · PDFium chromium/8138 (bblanchon) ·
pdfium-render 0.9.5 (copie locale corrigée) · Rust 1.99.1 · Tauri 2.12.

**Verdict : le moteur natif est validé.** On garde l'architecture : PDFium natif en Rust, tuiles
servies à la WebView, interface React. Sept critères sur huit passent. Le premier ne passe qu'en
partie : le corpus est trop petit (11 fichiers au lieu de 30) et les polices japonaises posent
problème. Six problèmes ont été trouvés ; tous ont une parade, et quatre sont déjà corrigés dans
le code du spike.

## Comment reproduire

```bash
python tools/corpus/make_corpus.py          # corpus maison (venv : reportlab, pypdf, pikepdf, pillow)
cargo run --release -p pdfreader-engine --bin m0         # critères 1 à 6
cargo run --release -p pdfreader-engine --bin m0print    # critère 7
cd apps/desktop && npx tauri build --no-bundle && ../../target/release/pdfreader-desktop.exe   # critère 2 (WebView)
cargo deny check licenses && python tools/check-npm-licenses.py                              # critère 8
```

Les sorties (PNG, PDF, `rapport.txt`, `webview-bench.json`) sont dans `target/m0-out/`.

## Résultats par critère

| # | critère | objectif | mesuré | verdict |
| --- | --- | --- | --- | --- |
| 1 | PDF variés rendus sans défaut | 30 fichiers | 11 fichiers maison : texte, 1 000 pages, police non embarquée, transparence et dégradé, CJK, scan, tailles mixtes et rotation, AcroForm, chiffrés AES-256, 2 Go. Rendu de la page 1 à 150 % en 1,6 à 13 ms. **Le japonais non embarqué ne s'affiche pas** (le chinois oui). | **partiel** |
| 2 | tuile 512 px dans la WebView | < 30 ms | **WebP sans perte : 5,4 ms** (médiane, p95 7,5 ms) dont rendu 1,2 + encodage 0,9 + transfert et décodage 3,0. Page scannée : 9,8 ms. RGBA brut : 12,9 ms (650 Ko par tuile contre 24 Ko). | **oui** |
| 2 | première page | < 300 ms | page entière à 150 % (6 tuiles en parallèle) : **17,5 ms** | **oui** |
| 2 | défilement à 60 images/s | 60 i/s | non mesuré (il faut l'interface de défilement, en M1) | à faire |
| 3 | PDF de 2 Go | < 300 Mo, lecture par blocs | ouverture 0,1 ms (865 ms à froid, cache disque vide), **moins de 5 Ko lus en 11 lectures**, mémoire +1 Mo | **oui** |
| 4 | annotations en incrémental | lisibles ailleurs | surlignage + note ajoutés ; le fichier d'origine reste intact en tête (+4,5 Ko ajoutés) ; apparences /AP présentes après correctif | **oui** (vérifié avec PDFium et pikepdf ; à revoir dans Acrobat et Firefox) |
| 5 | PDF chiffré AES-256 | rouvrir, réenregistrer chiffré | refus sans mot de passe et avec un mauvais ; annotation ajoutée ; le fichier reste chiffré (R6) | **oui** |
| 6 | formulaire AcroForm | rempli, relu ailleurs | valeurs relues ; texte, case et radio s'affichent **en passant par le moteur interactif** | **oui** (après correctif) |
| 7 | impression vectorielle | Microsoft Print to PDF | 2 pages imprimées en 3,3 s ; texte en contours vectoriels (pas d'image) ; surlignage et note imprimés après correctif | **oui** |
| 8 | licences | aucune GPL/AGPL | `cargo deny check licenses` : ok · npm livré (18 paquets) : MIT, Apache-2.0, ISC, 0BSD : ok | **oui** |

Mémoire du moteur seul : 7 Mo au démarrage, 12 à 17 Mo pendant les tests. La mémoire totale de
l'app avec WebView2 n'a pas été mesurée.

## Problèmes trouvés et parades

1. **La sauvegarde incrémentale n'est pas exposée par pdfium-render.** *Corrigé* : copie locale
   `vendor/pdfium-render` avec `save_to_writer_with_flags()`, plus l'accès aux handles bruts
   (`raw_handle()`, `raw_bindings()`) pour les appels non couverts. Licence MIT/Apache : la
   modification est permise. À proposer en amont, puis supprimer la copie.
2. **Annotations créées sans apparence (/AP).** Certains lecteurs ne les affichent pas. *Corrigé* :
   on rend la page une fois après la modification, ce qui fait générer l'apparence par PDFium
   (surlignage en mode `Multiply`), avant la sauvegarde. *À noter :* `PdfQuadPoints::from_rect`
   produit un ordre de points incorrect et donc une apparence vide : ne pas l'utiliser (corrigé
   dans `highlight_first`).
3. **Remplir un champ avec `set_value` ne régénère pas son apparence.** La valeur est enregistrée
   mais le champ s'affiche vide (ici et dans les autres lecteurs). *Corrigé* : passer par le
   moteur de formulaires interactif de PDFium (`FORM_OnLButtonDown`, `FORM_ReplaceSelection`,
   `FORM_ForceToKillFocus`), qui régénère l'apparence. Conséquence pour l'interface : la saisie
   dans les champs HTML superposés est validée dans PDFium par ces appels.
4. **Annotations non imprimées** sans le drapeau « Imprimer » (/F 4). *Corrigé* : toute
   annotation créée reçoit ce drapeau. Pour l'option « Imprimer les commentaires » de S13, il
   faudra aussi gérer les annotations existantes sans ce drapeau.
5. **Police japonaise non embarquée invisible.** La machine a MS Gothic et Yu Gothic, mais pas de
   Mincho ; PDFium ne trouve pas de remplaçante pour `HeiseiMin-W3`. *Parade (M2)* : une table de
   correspondance des polices (`FPDF_SetSystemFontInfo`) qui associe chaque collection CJK
   (Japan1, GB1, CNS1, Korea1) à une police disponible. On peut aussi embarquer Noto CJK (OFL,
   environ 20 Mo par police) en composant facultatif de l'installeur. Le texte japonais reste
   extractible : seul l'affichage manque.
6. **Les permissions d'un PDF chiffré en AES-256 (R6) ne sont pas lues par pdfium-render**
   (`UnknownPdfSecurityHandlerRevision`). *Parade (M2)* : lire les droits par l'API brute
   (`FPDF_GetDocPermissions`, `FPDF_GetDocUserPermissions`). C'est indispensable pour respecter
   « impression interdite » et « copie interdite ».

## Observations

- **Format des tuiles : WebP sans perte** (2,4 fois plus rapide que le RGBA brut et 27 fois plus
  léger). C'est le choix retenu ; le RGBA brut reste un repli.
- **Impression** : le texte sort en contours vectoriels (net à toute résolution), mais le contenu
  est lourd (2,8 Mo par page vers le PDF virtuel). À tester sur une vraie imprimante. Si le
  spoule est trop lent, il faudra tester le mode PostScript de PDFium (`FPDF_SetPrintMode`).
- **Ouverture à froid** du fichier de 2 Go : 865 ms. C'est le cache disque de Windows, pas une
  lecture du fichier (moins de 5 Ko lus).
- Le corpus maison contient deux défauts propres aux fichiers de test (la ligature « fi » mal
  encodée par reportlab, et un dégradé corrigé), pas au moteur.

## Ce qui reste avant de passer à M1

- **Élargir le corpus à 30 fichiers ou plus** avec des PDF publics réels sous licence libre
  (suites de tests de la PDF Association, corpus de pdf.js en Apache-2.0) : PDF balisés, signés,
  avec calques, très lourds en images, mal formés. Jamais de fichiers produits par Acrobat pour
  comparaison.
- Vérifier les fichiers annotés et remplis dans d'autres lecteurs (Firefox, et Acrobat Reader
  pour une vérification manuelle de compatibilité, sans automatisation).
- Mesurer le défilement à 60 images/s et la mémoire totale de l'app dans la tranche verticale M1.

## Fichiers du spike

| fichier | rôle |
| --- | --- |
| `crates/engine/src/lib.rs` | ouverture par blocs, rendu en tuiles, surlignage, note, remplissage interactif, sauvegarde incrémentale atomique |
| `crates/engine/src/print_win.rs` | impression native GDI |
| `crates/engine/src/bin/m0.rs`, `m0print.rs`, `m0png.rs` | bancs d'essai et outil de rendu |
| `apps/desktop/src-tauri/src/main.rs` | coquille Tauri, thread moteur, protocole `pdfpage://` |
| `apps/desktop/src/main.ts` | mesures côté WebView |
| `tools/corpus/make_corpus.py` | corpus maison |
| `tools/check-npm-licenses.py`, `deny.toml` | contrôle des licences |
| `vendor/pdfium-render/` | copie corrigée (voir `vendor/README.md`) |
