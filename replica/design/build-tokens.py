#!/usr/bin/env python3
"""Génère tokens.css (propriétés CSS, 3 thèmes + forced-colors + tactile + mouvement réduit)
et tailwind-theme.css (mappage Tailwind v4 via @theme inline) depuis tokens.json.

    python build-tokens.py [dossier_de_sortie ...]

Sans argument : écrit dans ce dossier ET dans packages/ui/src/styles/ s'il existe.
Ne jamais modifier les CSS générés à la main : modifier tokens.json puis relancer.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
HEADER = "/* GÉNÉRÉ par replica/design/build-tokens.py depuis tokens.json. Ne pas modifier à la main. */\n"


def rem(px):
    v = px / 16
    return ("%.4f" % v).rstrip("0").rstrip(".") + "rem"


def clean(d):
    return {k: v for k, v in d.items() if not k.startswith("_")}


def color_block(palette, indent="  "):
    return "\n".join("%s--%s: %s;" % (indent, k, v) for k, v in palette.items())


def shadow_block(shadows, indent="  "):
    return "\n".join("%s--elev-%s: %s;" % (indent, k, v) for k, v in shadows.items())


def build_tokens_css(t):
    light = t["color"]
    dark = t["themes"]["dark"]
    hc = t["themes"]["contrast"]
    annot = clean(t["annot"])
    size = clean(t["size"])
    layout = clean(t["layout"])
    out = [HEADER]

    # --- statique : typo, espacements, rayons, mouvement, tailles, z
    s = [":root {"]
    s.append("  color-scheme: light;")
    s.append(color_block(light))
    s.append(shadow_block(t["shadow"]))
    for k, v in annot.items():
        s.append("  --annot-%s: %s;" % (k, v))
    for k, v in t["font"].items():
        s.append("  --ff-%s: %s;" % (k, v))
    for k, v in clean(t["type"]).items():
        s.append("  --fs-%s: %s;" % (k, rem(v["size"])))
        s.append("  --lh-%s: %s;" % (k, rem(v["line"])))
        s.append("  --fw-%s: %s;" % (k, v["weight"]))
    for i, v in enumerate(t["space"]):
        s.append("  --space-%d: %s;" % (i, rem(v)))
    for k, v in t["radius"].items():
        s.append("  --r-%s: %s;" % (k, "999px" if v >= 999 else rem(v)))
    for k, v in t["motion"].items():
        s.append("  --motion-%s: %s;" % (k, v))
    for k in ("control-sm", "control-md", "control-lg"):
        s.append("  --%s: %s;" % (k, rem(size[k])))
    for k in ("icon-sm", "icon-md", "icon-lg"):
        s.append("  --%s: %s;" % (k, rem(size[k])))
    s.append("  --focus-ring: %spx;" % size["focus-ring"])
    s.append("  --focus-offset: %spx;" % size["focus-offset"])
    for k, v in layout.items():
        if isinstance(v, dict):
            continue
        s.append("  --layout-%s: %s;" % (k, rem(v)))
    for k, v in t["z"].items():
        s.append("  --z-%s: %s;" % (k, v))
    s.append("}")
    out.append("\n".join(s))

    # --- thème sombre : explicite, ou suivi du système si aucun thème n'est forcé
    dark_vars = "  color-scheme: dark;\n" + color_block(dark) + "\n" + shadow_block(t["shadow_dark"])
    out.append(':root[data-theme="dark"] {\n%s\n}' % dark_vars)
    out.append("@media (prefers-color-scheme: dark) {\n  :root:not([data-theme]) {\n%s\n  }\n}"
               % "\n".join("  " + l for l in dark_vars.split("\n")))

    # --- contraste élevé : explicite, ou si le système le demande
    hc_vars = "  color-scheme: dark;\n" + color_block(hc) + "\n" + shadow_block(
        {k: "none" for k in t["shadow"]}) + "\n  --page-outline: 2px solid #ffffff;"
    out.append(':root[data-theme="contrast"] {\n%s\n}' % hc_vars)
    out.append("@media (prefers-contrast: more) {\n  :root:not([data-theme]) {\n%s\n  }\n}"
               % "\n".join("  " + l for l in hc_vars.split("\n")))

    # --- Windows « contraste élevé » (forced-colors) : couleurs système, rien d'autre
    fc = {
        "bg": "Canvas", "surface": "Canvas", "surface-raised": "Canvas",
        "surface-hover": "Canvas", "surface-selected": "Highlight", "canvas": "Canvas",
        "border": "CanvasText", "border-strong": "CanvasText", "border-input": "ButtonBorder",
        "text": "CanvasText", "text-muted": "CanvasText", "accent": "Highlight",
        "accent-hover": "Highlight", "accent-text": "LinkText", "on-accent": "HighlightText",
        "focus": "Highlight", "danger": "CanvasText", "danger-hover": "CanvasText",
        "on-danger": "Canvas", "success": "CanvasText", "warning": "CanvasText",
        "info-bg": "Canvas", "warning-bg": "Canvas", "danger-bg": "Canvas", "success-bg": "Canvas",
        "search-hit": "Mark", "search-hit-current": "Highlight",
    }
    fc_vars = color_block(fc, "    ") + "\n" + shadow_block({k: "none" for k in t["shadow"]}, "    ")
    out.append("@media (forced-colors: active) {\n  :root {\n%s\n    --page-outline: 1px solid CanvasText;\n  }\n}" % fc_vars)

    # --- tactile : cibles plus grandes
    coarse = "\n".join("    --%s: %s;" % (k, rem(size[k + "-coarse"]))
                       for k in ("control-sm", "control-md", "control-lg"))
    out.append("@media (pointer: coarse) {\n  :root {\n%s\n  }\n}" % coarse)

    # --- mouvement réduit
    out.append("@media (prefers-reduced-motion: reduce) {\n  :root {\n"
               "    --motion-fast: 0ms;\n    --motion-base: 0ms;\n    --motion-slow: 0ms;\n  }\n}")
    return "\n\n".join(out) + "\n"


def build_tailwind_css(t):
    light = t["color"]
    lines = [HEADER, "/* Mappage Tailwind v4 : bg-surface, text-muted, border-input, rounded-md… jamais d'hexa dans les composants. */",
             "@theme inline {"]
    lines.append("  --color-*: initial;")
    for k in light:
        name = k
        if k == "text":
            name = "fg"            # text-fg (évite text-text)
        elif k == "text-muted":
            name = "muted"         # text-muted
        lines.append("  --color-%s: var(--%s);" % (name, k))
    for k in clean(t["annot"]):
        lines.append("  --color-annot-%s: var(--annot-%s);" % (k, k))
    lines.append("  --color-transparent: transparent;")
    lines.append("  --color-current: currentColor;")
    lines.append("  --color-white: #ffffff;")
    lines.append("  --color-black: #000000;")
    for k in t["font"]:
        lines.append("  --font-%s: var(--ff-%s);" % (k, k))
    for k in clean(t["type"]):
        lines.append("  --text-%s: var(--fs-%s);" % (k, k))
        lines.append("  --text-%s--line-height: var(--lh-%s);" % (k, k))
    lines.append("  --spacing: 0.25rem;")
    for k in t["radius"]:
        lines.append("  --radius-%s: var(--r-%s);" % (k, k))
    for k in t["shadow"]:
        lines.append("  --shadow-%s: var(--elev-%s);" % (k, k))
    for k, v in t["layout"]["breakpoints"].items():
        lines.append("  --breakpoint-%s: %s;" % (k, rem(v)))
    lines.append("  --ease-standard: var(--motion-ease);")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main():
    with open(os.path.join(HERE, "tokens.json"), encoding="utf-8") as fh:
        t = json.load(fh)
    outs = sys.argv[1:] or [HERE]
    ui = os.path.join(ROOT, "packages", "ui", "src", "styles")
    if not sys.argv[1:] and os.path.isdir(ui):
        outs.append(ui)
    css, tw = build_tokens_css(t), build_tailwind_css(t)
    for d in outs:
        os.makedirs(d, exist_ok=True)
        for name, content in (("tokens.css", css), ("tailwind-theme.css", tw)):
            with open(os.path.join(d, name), "w", encoding="utf-8", newline="\n") as fh:
                fh.write(content)
        print("écrit : %s" % os.path.relpath(d, ROOT))


if __name__ == "__main__":
    main()
