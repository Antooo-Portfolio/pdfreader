#!/usr/bin/env python3
"""Catalogue de traduction : extrait les phrases de t("…") et msg("…") du code de l'interface et
met à jour packages/ui/src/locales/en.json (les traductions existantes sont gardées, les phrases
disparues retirées).

    python tools/i18n/extract.py           met à jour le catalogue, liste les manques
    python tools/i18n/extract.py --check   n'écrit rien ; code de sortie 1 s'il manque des traductions
"""
import glob
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CATALOG = os.path.join(ROOT, "packages", "ui", "src", "locales", "en.json")
SOURCES = [
    *glob.glob(os.path.join(ROOT, "packages", "viewer", "src", "*.ts*")),
    *glob.glob(os.path.join(ROOT, "packages", "ui", "src", "**", "*.ts*"), recursive=True),
    *glob.glob(os.path.join(ROOT, "apps", "desktop", "src", "*.ts*")),
]
STR = r'"((?:[^"\\]|\\.)*)"'
CALL = re.compile(r"\b(?:t|msg)\(\s*" + STR)
TERNARY = re.compile(r"\bt\([^\"()]*\?\s*" + STR + r"\s*:\s*" + STR)


def unescape(s):
    return json.loads(f'"{s}"')


def keys():
    found = {}
    for path in SOURCES:
        if path.endswith(("e2e.ts", "i18n.ts")):
            continue
        src = open(path, encoding="utf-8").read()
        for m in CALL.finditer(src):
            found.setdefault(unescape(m.group(1)), os.path.relpath(path, ROOT))
        for m in TERNARY.finditer(src):
            for g in (1, 2):
                found.setdefault(unescape(m.group(g)), os.path.relpath(path, ROOT))
    return found


def main():
    check = "--check" in sys.argv
    found = keys()
    old = json.load(open(CATALOG, encoding="utf-8")) if os.path.exists(CATALOG) else {}
    new = {k: old.get(k, "") for k in sorted(found, key=str.lower)}
    missing = [k for k, v in new.items() if not v]
    removed = [k for k in old if k not in found]
    if not check:
        with open(CATALOG, "w", encoding="utf-8", newline="\n") as f:
            json.dump(new, f, ensure_ascii=False, indent=2)
            f.write("\n")
    print(f"{len(new)} phrases, {len(missing)} sans traduction anglaise, {len(removed)} retirée(s)")
    for k in missing[:40]:
        print("  manque :", k, f"({found[k]})")
    if check and missing:
        sys.exit(1)


main()
