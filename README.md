# PDFReader

Lecteur PDF gratuit pour Windows : lire, annoter, remplir des formulaires, signer et imprimer.
Sans compte, sans publicité ; vos documents restent sur votre ordinateur.

- **Télécharger** : [dernière version](https://github.com/Antooo-Portfolio/pdfreader/releases/latest)
- **Site** : https://portfolio.antonyrodrigues.fr/pdfreader/
- [Confidentialité](https://portfolio.antonyrodrigues.fr/pdfreader/confidentialite.html) ·
  [Contrat de licence](https://portfolio.antonyrodrigues.fr/pdfreader/licence.html) ·
  [Composants tiers](https://portfolio.antonyrodrigues.fr/pdfreader/THIRD-PARTY-NOTICES.txt)

## Code

Application de bureau Tauri 2 (Rust, WebView2) ; rendu et édition des PDF par PDFium.

- `apps/desktop` : l'application (pont Tauri, installeur NSIS, mises à jour signées)
- `crates/engine` : moteur PDF (lecture, annotations, formulaires, impression)
- `packages/ui`, `packages/viewer` : interface React (français et anglais)
- `tools/` : corpus de test, traductions, licences, préparation des versions
- `replica/` : cadrage, architecture et journal de construction

Le code est visible mais n'est pas sous licence libre : voir le
[contrat de licence](apps/desktop/src-tauri/legal/LICENCE.txt).

---

Free PDF reader for Windows: read, annotate, fill in forms, sign and print. No account, no ads;
your documents stay on your computer. [Download the latest version](https://github.com/Antooo-Portfolio/pdfreader/releases/latest) ·
[Website](https://portfolio.antonyrodrigues.fr/pdfreader/en/)
