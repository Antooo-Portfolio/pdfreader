#!/usr/bin/env python3
"""Vérifie les licences des dépendances npm LIVRÉES (code fermé : permissives uniquement).

Part des dépendances de production des paquets livrés (@pdfreader/ui, @pdfreader/desktop),
suit l'arbre dans node_modules et refuse toute licence hors liste blanche.
Bibliothèque standard uniquement, aucun outil tiers.

    python tools/check-npm-licenses.py
"""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
NM = os.path.join(ROOT, "node_modules")
SHIPPED = ["packages/ui", "apps/desktop"]
ALLOW = {"MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Zlib",
         "CC0-1.0", "OFL-1.1", "BlueOak-1.0.0", "Unicode-3.0", "Python-2.0"}


def read(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def find_pkg(name, from_dir):
    d = from_dir
    while True:
        cand = os.path.join(d, "node_modules", name, "package.json")
        if os.path.exists(cand):
            return cand
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def license_ok(lic):
    if not lic:
        return False
    lic = lic.strip("()")
    if " OR " in lic:
        return any(license_ok(p) for p in lic.split(" OR "))
    if " AND " in lic:
        return all(license_ok(p) for p in lic.split(" AND "))
    return lic in ALLOW


def main():
    seen, bad, todo = {}, [], []
    for p in SHIPPED:
        pj = read(os.path.join(ROOT, p, "package.json"))
        for dep in pj.get("dependencies", {}):
            todo.append((dep, os.path.join(ROOT, p)))
        for dep in pj.get("peerDependencies", {}):
            todo.append((dep, os.path.join(ROOT, p)))
    while todo:
        name, base = todo.pop()
        path = find_pkg(name, base)
        if not path or path in seen:
            continue
        pj = read(path)
        lic = pj.get("license")
        if isinstance(lic, dict):
            lic = lic.get("type")
        seen[path] = (pj["name"], pj.get("version"), lic)
        if not license_ok(lic):
            bad.append(seen[path])
        for dep in {**pj.get("dependencies", {}), **pj.get("optionalDependencies", {})}:
            todo.append((dep, os.path.dirname(path)))
    counts = {}
    for _, _, lic in seen.values():
        counts[lic] = counts.get(lic, 0) + 1
    print("%d paquets livrés : %s" % (len(seen), ", ".join("%s × %d" % kv for kv in sorted(counts.items(), key=lambda kv: -kv[1]))))
    for n, v, lic in bad:
        print("  REFUSÉ  %s@%s : %s" % (n, v, lic))
    print("licences npm : %s" % ("ÉCHEC" if bad else "ok"))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
