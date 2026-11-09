#!/usr/bin/env python3
"""Vérifie le contraste WCAG des 3 thèmes de tokens.json (clair, sombre, contraste élevé),
plus l'encre du PDF sur les couleurs d'annotation. S'appuie sur contrast.py (même dossier).

    python check-contrast.py [tokens.json]

Code de sortie 1 si une paire échoue en AA, dans n'importe quel thème.
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("contrast", os.path.join(HERE, "contrast.py"))
contrast = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contrast)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "tokens.json")
    with open(path, encoding="utf-8") as fh:
        tokens = json.load(fh)

    themes = {"light": tokens["color"]}
    themes.update(tokens.get("themes", {}))
    annot = {k: v for k, v in tokens.get("annot", {}).items() if not k.startswith("_")}

    failed = False
    for name, palette in themes.items():
        cols = contrast.colours({"color": palette})
        print("== thème %s" % name)
        rows = contrast.check(cols, tokens["pairs"])
        print(contrast.render(rows))
        failed |= any("error" in r or not r["aa"] for r in rows)

        # encre du document sur les annotations et les résultats de recherche
        merged = dict(annot)
        merged["search-hit"] = palette["search-hit"]
        merged["search-hit-current"] = palette["search-hit-current"]
        cols = contrast.colours({"color": merged})
        rows = contrast.check(cols, tokens.get("annot_pairs", []))
        print("   -- encre du PDF sur annotations")
        print(contrast.render(rows))
        failed |= any("error" in r or not r["aa"] for r in rows)
        print()

    print("RÉSULTAT : %s" % ("ÉCHEC" if failed else "0 échec AA sur les 3 thèmes"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
