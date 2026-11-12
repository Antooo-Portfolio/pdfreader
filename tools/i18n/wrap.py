#!/usr/bin/env python3
"""Outil de développement : encadre les phrases de l'interface par t("…") (passage unique,
relu ensuite à la main). Traite les attributs JSX de texte, les lignes de texte JSX et les
propriétés `message` / `label` / `title` / `description` des objets écrits dans les composants.

    python tools/i18n/wrap.py fichier.tsx [...]
"""
import re
import sys

ATTRS = r"label|title|aria-label|placeholder|description|errorMessage|textValue|colorName"
attr_re = re.compile(r'(\s)(' + ATTRS + r')="([^"{}]*[A-Za-zÀ-ÿ][^"{}]*)"')
prop_re = re.compile(r'(\b(?:message|label|title|description)): "([^"]*[A-Za-zÀ-ÿ][^"]*)"')
letters = re.compile(r"[A-Za-zÀ-ÿ]{2,}")


def esc(s):
    return s.replace("\\", "\\\\").replace('"', '\\"')


def is_jsx_text(lines, i):
    raw = lines[i]
    s = raw.strip()
    if not s or not letters.search(s):
        return False
    if s[0] in '|"\'`.?&+-*/@#$%^=<>{}()[];:,!' or s.startswith("//"):
        return False
    if any(c in s for c in '{}<>="`;') or "=>" in s:
        return False
    # Mots-clés de code qui ressemblent à du texte.
    if re.match(r"^(return|break|continue|else|default|case|import|export|const|let|type|interface|function|async|await|new|throw|if|for|while)\b", s):
        return False
    prev = next((lines[j].strip() for j in range(i - 1, -1, -1) if lines[j].strip()), "")
    nxt = next((lines[j].strip() for j in range(i + 1, len(lines)) if lines[j].strip()), "")
    return prev.endswith(">") or nxt.startswith("<") or nxt.startswith("{")


def transform(src):
    lines = src.split("\n")
    out = []
    for i, line in enumerate(lines):
        if is_jsx_text(lines, i):
            indent = line[: len(line) - len(line.lstrip())]
            text = line.strip()
            # Espace finale significative avant une expression JSX : gardée dans la phrase.
            out.append(f'{indent}{{t("{esc(text)}")}}')
            continue
        line = attr_re.sub(lambda m: f'{m.group(1)}{m.group(2)}={{t("{esc(m.group(3))}")}}', line)
        indent = len(line) - len(line.lstrip())
        if indent >= 6:
            line = prop_re.sub(lambda m: f'{m.group(1)}: t("{esc(m.group(2))}")', line)
        out.append(line)
    return "\n".join(out)


for path in sys.argv[1:]:
    src = open(path, encoding="utf-8").read()
    new = transform(src)
    if new != src:
        open(path, "w", encoding="utf-8", newline="\n").write(new)
        print("modifié :", path)
