#!/usr/bin/env python3
"""Mentions des composants tiers livrés avec PDFReader (obligatoires en code fermé : les licences
MIT, BSD, Apache et OFL demandent de reproduire les mentions de droits d'auteur et la licence).

Produit, dans apps/desktop/src-tauri/legal/ :
  - THIRD-PARTY-NOTICES.txt : liste des composants puis texte des licences (installé avec l'app) ;
  - third-party.json        : résumé (nom, version, licence) affiché dans « À propos ».

Composants : crates Rust de l'application (dépendances normales, cible Windows), paquets npm
livrés (dépendances de production de l'interface), PDFium et les bibliothèques qu'il contient,
polices. Bibliothèque standard uniquement.

    python tools/licenses/notices.py
"""
import glob
import json
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "apps", "desktop", "src-tauri", "legal")
OWN = {"pdfreader-desktop", "pdfreader-engine"}
LICENSE_FILES = ("LICENSE", "LICENCE", "COPYING", "NOTICE", "COPYRIGHT", "UNLICENSE")


def license_texts(directory):
    """Fichiers de licence d'un paquet (LICENSE, LICENSE-MIT, COPYING…), triés."""
    out = []
    if not os.path.isdir(directory):
        return out
    for f in sorted(os.listdir(directory)):
        if f.upper().startswith(LICENSE_FILES) and os.path.isfile(os.path.join(directory, f)):
            try:
                txt = open(os.path.join(directory, f), encoding="utf-8", errors="replace").read().strip()
            except OSError:
                continue
            if txt:
                out.append((f, txt))
    return out


def rust_components():
    meta = json.loads(
        subprocess.run(
            ["cargo", "metadata", "--format-version", "1", "--offline", "--filter-platform", "x86_64-pc-windows-msvc"],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True,
        ).stdout
    )
    pkgs = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    root = next(p["id"] for p in meta["packages"] if p["name"] == "pdfreader-desktop")
    # Dépendances normales seulement (les dépendances de compilation ne sont pas livrées).
    seen, todo = set(), [root]
    while todo:
        nid = todo.pop()
        if nid in seen:
            continue
        seen.add(nid)
        for d in nodes[nid]["deps"]:
            if any(k["kind"] is None for k in d["dep_kinds"]):
                todo.append(d["pkg"])
    out = []
    for nid in seen:
        p = pkgs[nid]
        if p["name"] in OWN:
            continue
        lic = p.get("license") or ("voir le fichier de licence" if p.get("license_file") else "non indiquée")
        out.append({"name": p["name"], "version": p["version"], "license": lic, "kind": "Rust",
                    "url": p.get("repository") or p.get("homepage") or "",
                    "texts": license_texts(os.path.dirname(p["manifest_path"]))})
    return out


def npm_components():
    nm = os.path.join(ROOT, "node_modules")

    def find(name, base):
        d = base
        while True:
            c = os.path.join(d, "node_modules", name, "package.json")
            if os.path.exists(c):
                return c
            parent = os.path.dirname(d)
            if parent == d:
                return None
            d = parent

    todo, seen, out = [], set(), []
    for p in ("packages/ui", "packages/viewer", "apps/desktop"):
        pj = json.load(open(os.path.join(ROOT, p, "package.json"), encoding="utf-8"))
        for dep in list(pj.get("dependencies", {})) + list(pj.get("peerDependencies", {})):
            todo.append((dep, os.path.join(ROOT, p)))
    while todo:
        name, base = todo.pop()
        if name.startswith("@pdfreader/"):
            continue
        path = find(name, base)
        if not path or path in seen:
            continue
        seen.add(path)
        pj = json.load(open(path, encoding="utf-8"))
        lic = pj.get("license")
        if isinstance(lic, dict):
            lic = lic.get("type")
        repo = pj.get("repository")
        if isinstance(repo, dict):
            repo = repo.get("url")
        out.append({"name": pj["name"], "version": pj.get("version", ""), "license": lic or "non indiquée", "kind": "npm",
                    "url": (repo or pj.get("homepage") or "").replace("git+", ""), "texts": license_texts(os.path.dirname(path))})
        for dep in pj.get("dependencies", {}):
            todo.append((dep, os.path.dirname(path)))
    assert os.path.isdir(nm)
    return out


def native_components():
    base = os.path.join(ROOT, "vendor", "pdfium-win-x64")
    version = open(os.path.join(base, "VERSION"), encoding="utf-8").read().split()
    v = next((x.split("=")[1] for x in version if x.startswith("BUILD=")), "")
    out = [{"name": "PDFium", "version": f"chromium/{v}" if v else "", "license": "BSD-3-Clause AND Apache-2.0", "kind": "natif",
            "url": "https://pdfium.googlesource.com/pdfium/", "texts": [("LICENSE", open(os.path.join(base, "LICENSE"), encoding="utf-8").read().strip())]}]
    for f in sorted(glob.glob(os.path.join(base, "licenses", "*.txt"))):
        name = os.path.splitext(os.path.basename(f))[0]
        out.append({"name": f"{name} (dans PDFium)", "version": "", "license": "incluse avec PDFium (voir le texte)", "kind": "natif", "url": "",
                    "texts": [(os.path.basename(f), open(f, encoding="utf-8", errors="replace").read().strip())]})
    return out


def main():
    comps = rust_components() + npm_components() + native_components()
    # PDFium d'abord, puis les bibliothèques qu'il contient, puis Rust et npm.
    comps.sort(key=lambda c: (c["kind"] != "natif", "(dans PDFium)" in c["name"], c["kind"], c["name"].lower()))
    os.makedirs(OUT, exist_ok=True)
    lines = [
        "PDFReader — mentions des composants tiers / third-party notices",
        "=" * 64,
        "",
        "PDFReader utilise les composants libres ci-dessous, chacun sous sa propre licence.",
        "PDFReader uses the open-source components below, each under its own licence.",
        "",
    ]
    for c in comps:
        lines.append(f"- {c['name']} {c['version']} ({c['kind']}) : {c['license']}" + (f" — {c['url']}" if c["url"] else ""))
    lines += ["", "", "Textes des licences / licence texts", "=" * 64]
    # Un même texte n'est reproduit qu'une fois, avec la liste des composants qui l'utilisent.
    by_text = {}
    for c in comps:
        for fname, txt in c["texts"]:
            by_text.setdefault(txt, []).append(f"{c['name']} {c['version']}".strip())
    missing = [c for c in comps if not c["texts"]]
    for txt, users in by_text.items():
        lines += ["", "-" * 64, "Pour / for : " + ", ".join(sorted(set(users))), "-" * 64, "", txt]
    if missing:
        lines += ["", "-" * 64, "Composants sans fichier de licence fourni : licence indiquée dans la liste ci-dessus.",
                  "Components without a bundled licence file: licence as listed above.", "-" * 64]
        lines += [f"- {c['name']} {c['version']} : {c['license']}" for c in missing]
    open(os.path.join(OUT, "THIRD-PARTY-NOTICES.txt"), "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")
    summary = [{k: c[k] for k in ("name", "version", "license", "kind", "url")} for c in comps]
    json.dump(summary, open(os.path.join(OUT, "third-party.json"), "w", encoding="utf-8", newline="\n"), ensure_ascii=False, indent=1)
    size = os.path.getsize(os.path.join(OUT, "THIRD-PARTY-NOTICES.txt"))
    print(f"{len(comps)} composants ({sum(1 for c in comps if c['kind'] == 'Rust')} Rust, {sum(1 for c in comps if c['kind'] == 'npm')} npm, "
          f"{sum(1 for c in comps if c['kind'] == 'natif')} natifs) ; {len(by_text)} textes de licence ; {len(missing)} sans fichier ; {size // 1024} Ko")


main()
