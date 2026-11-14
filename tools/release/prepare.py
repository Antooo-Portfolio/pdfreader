#!/usr/bin/env python3
"""Prépare une version à publier (sans rien envoyer) :

  target/release-upload/
    PDFReader_<v>_x64-setup.exe      installeur
    PDFReader_<v>_x64-setup.exe.sig  signature Ed25519 de l'updater
    PDFReader_<v>_x64-offline-setup.exe  setup hors ligne (WebView2 embarqué), hors updater
    latest.json                      lu par l'updater de l'application
  site/  licence.html, THIRD-PARTY-NOTICES.txt à jour

À lancer après `python tools/release/build.py` puis `build.py --offline` (clé privée gardée hors du
dépôt, %USERPROFILE%\\.tauri\\pdfreader-updater.key). La publication (Release GitHub du dépôt
Antooo-Portfolio/pdfreader) se fait ensuite avec gh ; le site est déployé par la CI (pages.yml).

    python tools/release/prepare.py [--notes "texte"] [--base-url URL]
"""
import argparse
import datetime
import html
import json
import os
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CONF = os.path.join(ROOT, "apps", "desktop", "src-tauri", "tauri.conf.json")
NSIS = os.path.join(ROOT, "target", "release", "bundle", "nsis")
LEGAL = os.path.join(ROOT, "apps", "desktop", "src-tauri", "legal")
SITE = os.path.join(ROOT, "site")
OUT = os.path.join(ROOT, "target", "release-upload")


# Paragraphe du site sur la version hors ligne : ajouté à la première version qui la contient
# (pas avant : le lien « Télécharger » mène à la dernière version publiée).
OFFLINE_TEXT = {
    "index.html": (
        "installation sans droits d'administrateur</p>",
        '<p class="small" id="offline">Ordinateur sans Internet ? Prenez sur la même page la version hors ligne, '
        "<code>PDFReader_x.y.z_x64-offline-setup.exe</code> (environ {mb} Mo) : elle contient l'installeur de WebView2 "
        "de Microsoft, le composant de Windows qui affiche l'interface, et l'installe s'il manque. Windows 11 l'a déjà ; "
        "la version normale le télécharge au besoin.</p>",
    ),
    os.path.join("en", "index.html"): (
        "installs without administrator rights</p>",
        '<p class="small" id="offline">Computer without Internet? Take the offline version from the same page, '
        "<code>PDFReader_x.y.z_x64-offline-setup.exe</code> (about {mb} MB): it contains Microsoft's WebView2 installer, "
        "the Windows component that displays the interface, and installs it if it is missing. Windows 11 already has it; "
        "the normal version downloads it when needed.</p>",
    ),
}


def announce_offline(size):
    mb = round(size / (1024 * 1024), -1)
    for page, (anchor, text) in OFFLINE_TEXT.items():
        path = os.path.join(SITE, page)
        s = open(path, encoding="utf-8").read()
        if 'id="offline"' in s:
            continue
        assert s.count(anchor) == 1, f"repère introuvable dans {path}"
        s = s.replace(anchor, anchor + "\n      " + text.format(mb=int(mb)))
        open(path, "w", encoding="utf-8", newline="\n").write(s)
        print(f"site : version hors ligne annoncée dans {page}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--notes", default="")
    ap.add_argument("--base-url", default="https://github.com/Antooo-Portfolio/pdfreader/releases/download")
    a = ap.parse_args()
    version = json.load(open(CONF, encoding="utf-8"))["version"]
    setup = os.path.join(NSIS, f"PDFReader_{version}_x64-setup.exe")
    sig = setup + ".sig"
    for f in (setup, sig):
        if not os.path.exists(f):
            sys.exit(f"absent : {f} (construire avec la clé de signature de l'updater)")
    os.makedirs(OUT, exist_ok=True)
    for f in (setup, sig):
        shutil.copy2(f, OUT)
    offline = os.path.join(NSIS, f"PDFReader_{version}_x64-offline-setup.exe")
    if os.path.exists(offline):
        shutil.copy2(offline, OUT)
        announce_offline(os.path.getsize(offline))
    else:
        print(f"attention : pas de setup hors ligne ({offline}) ; construire avec build.py --offline")
    name = os.path.basename(setup)
    latest = {
        "version": version,
        "notes": a.notes,
        "pub_date": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "platforms": {"windows-x86_64": {"signature": open(sig, encoding="utf-8").read().strip(), "url": f"{a.base_url}/v{version}/{name}"}},
    }
    json.dump(latest, open(os.path.join(OUT, "latest.json"), "w", encoding="utf-8", newline="\n"), ensure_ascii=False, indent=2)
    # Site : mentions et contrat de licence à jour.
    shutil.copy2(os.path.join(LEGAL, "THIRD-PARTY-NOTICES.txt"), SITE)
    licence = open(os.path.join(LEGAL, "LICENCE.txt"), encoding="utf-8-sig").read().replace("\r\n", "\n")
    fr, _, en = licence.partition("-" * 96)
    page = f"""<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Contrat de licence — PDFReader</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="top"><a class="brand" href="./">PDFReader</a></header>
  <main class="prose">
    <pre>{html.escape(fr.strip())}</pre>
    <pre id="en" lang="en">{html.escape(en.strip())}</pre>
  </main>
  <footer><a href="./">Accueil</a> · <a href="confidentialite.html">Confidentialité</a> · <a href="THIRD-PARTY-NOTICES.txt">Composants tiers</a></footer>
</body>
</html>
"""
    open(os.path.join(SITE, "licence.html"), "w", encoding="utf-8", newline="\n").write(page)
    print(f"version {version} prête dans {OUT} ; site mis à jour")


main()
