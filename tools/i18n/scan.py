#!/usr/bin/env python3
"""Outil de développement : liste les phrases françaises restées hors de t() / msg() dans
l'interface (chaînes, gabarits, texte JSX). Les commentaires et les classes CSS sont ignorés.

    python tools/i18n/scan.py
"""
import glob
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
FILES = [f for f in glob.glob("packages/viewer/src/*.ts*") + glob.glob("packages/ui/src/components/*.tsx") if not f.endswith(("e2e.ts", "i18n.ts"))]
FRENCH = re.compile(r"[éèêàçùûôîœÉÈÀÇ]|\b(le|la|les|des|du|une|un|est|pas|sur|pour|avec|dans|cette|votre|vos|aucun|aucune|page|pages|fichier|document|ouvrir|enregistrer|annuler|fermer|supprimer|modifier|ajouter)\b", re.I)
STR = re.compile(r'"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`')
SKIP_LINE = re.compile(r"^\s*(//|\*|/\*|import |export \* )")
IGNORE = re.compile(r"\b(t|msg|shortcutLabel|className|clsx)\($")


def scan(path):
    out = []
    for n, line in enumerate(open(path, encoding="utf-8"), 1):
        if SKIP_LINE.match(line):
            continue
        code = re.sub(r"//.*$", "", line)
        for m in STR.finditer(code):
            s = m.group(1) if m.group(1) is not None else m.group(2)
            if not s or not FRENCH.search(s):
                continue
            before = code[: m.start()]
            if re.search(r"\b(t|msg)\($", before) or "className" in before[-30:]:
                continue
            out.append((n, s[:90]))
        # Texte JSX resté brut.
        for m in re.finditer(r">([^<>{}]*[A-Za-zÀ-ÿ]{3,}[^<>{}]*)<", code):
            if FRENCH.search(m.group(1)) and "=>" not in m.group(1):
                out.append((n, "JSX " + m.group(1).strip()[:80]))
    return out


total = 0
for f in sorted(FILES):
    hits = scan(f)
    total += len(hits)
    for n, s in hits:
        print(f"{f}:{n}: {s}")
print(f"\n{total} restant(s)")
