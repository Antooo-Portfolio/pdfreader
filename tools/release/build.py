#!/usr/bin/env python3
"""Construit le setup Windows sans laisser de chemin de la machine de compilation dans
l'exécutable (dossier personnel, dossier du projet, fichier .pdb) : les chemins des sources Rust
sont réécrits (--remap-path-prefix) et le .pdb n'est cité que par son nom (/PDBALTPATH).

Signé pour l'updater si TAURI_SIGNING_PRIVATE_KEY est défini ou si la clé existe dans
%USERPROFILE%\\.tauri\\pdfreader-updater.key ; sinon (ou avec --unsigned), setup non signé.

    python tools/release/build.py [--unsigned] [autres options de `tauri build`]
"""
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
KEY = os.path.join(os.path.expanduser("~"), ".tauri", "pdfreader-updater.key")


def main():
    args = sys.argv[1:]
    unsigned = "--unsigned" in args
    args = [a for a in args if a != "--unsigned"]
    env = dict(os.environ)
    cargo_home = env.get("CARGO_HOME") or os.path.join(os.path.expanduser("~"), ".cargo")
    flags = [
        f"--remap-path-prefix={os.path.abspath(cargo_home)}=/cargo",
        f"--remap-path-prefix={ROOT}=/pdfreader",
        "-Clink-arg=/PDBALTPATH:%_PDB%",
    ]
    env["RUSTFLAGS"] = (env.get("RUSTFLAGS", "") + " " + " ".join(flags)).strip()
    if unsigned:
        env.pop("TAURI_SIGNING_PRIVATE_KEY", None)
    elif not env.get("TAURI_SIGNING_PRIVATE_KEY") and os.path.exists(KEY):
        env["TAURI_SIGNING_PRIVATE_KEY"] = open(KEY, encoding="utf-8").read().strip()
    if env.get("TAURI_SIGNING_PRIVATE_KEY"):
        env.setdefault("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "")
    else:
        args = ["--config", '{"bundle":{"createUpdaterArtifacts":false}}'] + args
        print("setup non signé pour l'updater")
    cmd = ["npx", "tauri", "build"] + args
    sys.exit(subprocess.call(cmd, cwd=os.path.join(ROOT, "apps", "desktop"), env=env, shell=os.name == "nt"))


main()
