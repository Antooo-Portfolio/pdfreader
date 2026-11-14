#!/usr/bin/env python3
"""Construit le setup Windows sans laisser de chemin de la machine de compilation dans
l'exécutable (dossier personnel, dossier du projet, fichier .pdb) : les chemins des sources Rust
sont réécrits (--remap-path-prefix) et le .pdb n'est cité que par son nom (/PDBALTPATH).

Signé pour l'updater si TAURI_SIGNING_PRIVATE_KEY est défini ou si la clé existe dans
%USERPROFILE%\\.tauri\\pdfreader-updater.key ; sinon (ou avec --unsigned), setup non signé.

--offline : setup hors ligne, PDFReader_<v>_x64-offline-setup.exe, qui embarque l'installeur
autonome de WebView2 (Microsoft, signé ; vérifié ici) et l'installe sans Internet s'il manque.
Plus lourd, il n'est pas proposé à l'updater : le setup normal reste celui des mises à jour et
n'est pas touché par cette construction.

    python tools/release/build.py [--unsigned] [--offline] [autres options de `tauri build`]
"""
import glob
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
KEY = os.path.join(os.path.expanduser("~"), ".tauri", "pdfreader-updater.key")
CONF = os.path.join(ROOT, "apps", "desktop", "src-tauri", "tauri.conf.json")
NSIS = os.path.join(ROOT, "target", "release", "bundle", "nsis")


def microsoft_signed(path):
    """Signature Authenticode valide, émise pour Microsoft Corporation."""
    ps = "$s = Get-AuthenticodeSignature -LiteralPath $env:CHECK_FILE; \"$($s.Status)|$($s.SignerCertificate.Subject)\""
    out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, env={**os.environ, "CHECK_FILE": path}).stdout.strip()
    status, _, subject = out.partition("|")
    return status == "Valid" and "O=Microsoft Corporation" in subject, out


def main():
    args = sys.argv[1:]
    unsigned = "--unsigned" in args
    offline = "--offline" in args
    args = [a for a in args if a not in ("--unsigned", "--offline")]
    env = dict(os.environ)
    cargo_home = env.get("CARGO_HOME") or os.path.join(os.path.expanduser("~"), ".cargo")
    flags = [
        f"--remap-path-prefix={os.path.abspath(cargo_home)}=/cargo",
        f"--remap-path-prefix={ROOT}=/pdfreader",
        "-Clink-arg=/PDBALTPATH:%_PDB%",
    ]
    env["RUSTFLAGS"] = (env.get("RUSTFLAGS", "") + " " + " ".join(flags)).strip()
    if unsigned or offline:
        env.pop("TAURI_SIGNING_PRIVATE_KEY", None)
    elif not env.get("TAURI_SIGNING_PRIVATE_KEY") and os.path.exists(KEY):
        env["TAURI_SIGNING_PRIVATE_KEY"] = open(KEY, encoding="utf-8").read().strip()
    override = {}
    if env.get("TAURI_SIGNING_PRIVATE_KEY"):
        env.setdefault("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "")
    else:
        override["createUpdaterArtifacts"] = False
        if not offline:
            print("setup non signé pour l'updater")
    if offline:
        override["windows"] = {"webviewInstallMode": {"type": "offlineInstaller", "silent": True}}
    if override:
        args = ["--config", json.dumps({"bundle": override})] + args
    version = json.load(open(CONF, encoding="utf-8"))["version"]
    online = os.path.join(NSIS, f"PDFReader_{version}_x64-setup.exe")
    # Le setup normal (et sa signature) est mis de côté pendant la construction hors ligne, qui
    # produit un fichier du même nom.
    kept = []
    if offline:
        for f in (online, online + ".sig"):
            if os.path.exists(f):
                shutil.move(f, f + ".keep")
                kept.append(f)
    code = 1
    try:
        cmd = ["npx", "tauri", "build"] + args
        code = subprocess.call(cmd, cwd=os.path.join(ROOT, "apps", "desktop"), env=env, shell=os.name == "nt")
        if code == 0 and offline:
            target = os.path.join(NSIS, f"PDFReader_{version}_x64-offline-setup.exe")
            shutil.move(online, target)
            # L'installeur de WebView2 embarqué doit venir de Microsoft, intact.
            cache = glob.glob(os.path.join(os.environ.get("LOCALAPPDATA", ""), "tauri", "**", "MicrosoftEdgeWebView2RuntimeInstaller*.exe"), recursive=True)
            if not cache:
                os.remove(target)
                sys.exit("installeur de WebView2 introuvable dans le cache de Tauri")
            for f in cache:
                ok, detail = microsoft_signed(f)
                if not ok:
                    os.remove(target)
                    sys.exit(f"signature de WebView2 refusée ({detail}) : {f}")
            print(f"setup hors ligne : {target} ({os.path.getsize(target) // (1024 * 1024)} Mo) ; WebView2 signé par Microsoft")
    finally:
        for f in kept:
            shutil.move(f + ".keep", f)
    sys.exit(code)


main()
