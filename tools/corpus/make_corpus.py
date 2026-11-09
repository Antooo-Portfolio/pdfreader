#!/usr/bin/env python3
"""Génère le corpus de test « maison » du spike M0 dans corpus/generated/.

Outil de développement (jamais livré). Dépendances de test : reportlab, pypdf, pikepdf, pillow.
Aucun fichier produit par Acrobat (CGU Adobe §17) : tout est fabriqué ici.

    python tools/corpus/make_corpus.py [--big-gb 2]
"""
import argparse
import io
import os
import random

import pikepdf
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, A5, letter, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "corpus", "generated")

LOREM = (
    "Le présent contrat a pour objet de définir les conditions dans lesquelles le bailleur met à "
    "disposition du preneur le local décrit ci-dessous. Les parties conviennent expressément que "
    "la durée, le loyer et les charges sont fixés selon les modalités suivantes, sous réserve des "
    "dispositions légales en vigueur. Œuvre, ﬁnancement, efficacité : ligatures et accents."
).split()


def para(rnd, n):
    return " ".join(rnd.choice(LOREM) for _ in range(n))


def text_pages(path, pages, title, size=A4, font="Helvetica"):
    rnd = random.Random(42)
    c = canvas.Canvas(path, pagesize=size)
    c.setTitle(title)
    c.setAuthor("Corpus PDFReader")
    w, h = size
    for p in range(1, pages + 1):
        c.setFont(font + "-Bold" if font == "Helvetica" else font, 18)
        c.drawString(56, h - 72, f"{title} — page {p}")
        c.setFont(font, 11)
        y = h - 110
        while y > 90:
            line = para(rnd, 12)
            c.drawString(56, y, line[:95])
            y -= 16
        c.setFont(font, 9)
        c.drawRightString(w - 56, 40, f"{p} / {pages}")
        c.bookmarkPage(f"p{p}")
        if p % 10 == 1:
            c.addOutlineEntry(f"Chapitre {(p // 10) + 1}", f"p{p}", level=0)
        c.showPage()
    c.save()


def vector_transparency(path):
    c = canvas.Canvas(path, pagesize=A4)
    w, h = A4
    c.setFont("Helvetica-Bold", 20)
    c.drawString(56, h - 72, "Vectoriel et transparence")
    for i, col in enumerate([colors.red, colors.green, colors.blue, colors.orange]):
        c.setFillColor(col, alpha=0.45)
        c.circle(180 + i * 70, h - 300, 110, stroke=0, fill=1)
    c.setFillAlpha(1)
    c.setStrokeColor(colors.black)
    for i in range(60):
        c.setLineWidth(0.25 + i * 0.05)
        c.line(56, 300 - i * 4, w - 56, 300 - i * 4 + (i % 7) * 3)
    c.saveState()
    p = c.beginPath()
    p.rect(56, 470, w - 112, 60)
    c.clipPath(p, stroke=0, fill=0)
    c.linearGradient(56, 500, w - 56, 500, (colors.white, colors.purple), extend=False)
    c.restoreState()
    c.showPage()
    c.save()


def cjk(path):
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiMin-W3"))
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    c = canvas.Canvas(path, pagesize=A4)
    w, h = A4
    c.setFont("HeiseiMin-W3", 16)
    c.drawString(56, h - 80, "日本語のテキスト：契約書の第一条")
    c.setFont("STSong-Light", 16)
    c.drawString(56, h - 120, "中文文本：本合同自双方签字之日起生效。")
    c.setFont("Helvetica", 12)
    c.drawString(56, h - 160, "Polices CJK non embarquées : teste la substitution de polices.")
    c.showPage()
    c.save()


def scanned(path):
    img = Image.new("L", (1240, 1754), 245)
    d = ImageDraw.Draw(img)
    try:
        f = ImageFont.truetype("arial.ttf", 28)
    except OSError:
        f = ImageFont.load_default()
    rnd = random.Random(7)
    y = 120
    while y < 1650:
        d.text((100, y), para(rnd, 9)[:70], fill=30, font=f)
        y += 44
    img = img.rotate(0.8, fillcolor=245)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=70)
    buf.seek(0)
    from reportlab.lib.utils import ImageReader

    c = canvas.Canvas(path, pagesize=A4)
    c.drawImage(ImageReader(buf), 0, 0, *A4)
    c.showPage()
    c.save()


def mixed_sizes(path):
    c = canvas.Canvas(path)
    for size, label, rot in [(A4, "A4 portrait", 0), (landscape(A4), "A4 paysage", 0), (A5, "A5", 0), (letter, "Letter", 0), (A4, "A4 /Rotate 90", 90)]:
        c.setPageSize(size)
        c.setFont("Helvetica-Bold", 24)
        c.drawString(56, size[1] - 80, label)
        c.rect(20, 20, size[0] - 40, size[1] - 40)
        c.showPage()
    c.save()
    pdf = pikepdf.open(path, allow_overwriting_input=True)
    pdf.pages[4].Rotate = 90
    pdf.save(path)


def form(path):
    c = canvas.Canvas(path, pagesize=A4)
    w, h = A4
    c.setFont("Helvetica-Bold", 18)
    c.drawString(56, h - 72, "Formulaire AcroForm de test")
    f = c.acroForm
    c.setFont("Helvetica", 11)
    c.drawString(56, h - 120, "Nom :")
    f.textfield(name="nom", tooltip="Nom", x=140, y=h - 130, width=300, height=20, borderStyle="inset", forceBorder=True)
    c.drawString(56, h - 160, "Commentaire :")
    f.textfield(name="commentaire", tooltip="Commentaire", x=140, y=h - 230, width=300, height=80, fieldFlags="multiline", forceBorder=True)
    c.drawString(56, h - 260, "J'accepte :")
    f.checkbox(name="accepte", tooltip="J'accepte", x=140, y=h - 266, size=16, buttonStyle="check")
    c.drawString(56, h - 300, "Formule :")
    for i, v in enumerate(["mensuelle", "annuelle"]):
        f.radio(name="formule", tooltip="Formule", value=v, selected=(i == 0), x=140 + i * 120, y=h - 306, size=16)
        c.drawString(162 + i * 120, h - 300, v)
    c.drawString(56, h - 340, "Pays :")
    f.choice(name="pays", tooltip="Pays", value="France", options=["France", "Belgique", "Suisse", "Canada"], x=140, y=h - 350, width=200, height=20, forceBorder=True)
    c.showPage()
    c.save()


def encrypt(src, dst, password):
    pdf = pikepdf.open(src)
    pdf.save(dst, encryption=pikepdf.Encryption(owner="owner-" + password, user=password, R=6, allow=pikepdf.Permissions(print_highres=False, extract=False)))


def big_with_attachment(path, gb):
    """PDF valide de ~gb Go : 3 pages de texte + une pièce jointe brute énorme, écrit à la main par
    morceaux (jamais en mémoire). Sert à vérifier que l'ouverture lit par blocs."""
    size = int(gb * 1024**3)
    objs = []
    with open(path, "wb") as fh:
        fh.write(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")

        def obj(num, body):
            objs.append((num, fh.tell()))
            fh.write(b"%d 0 obj\n" % num + body + b"\nendobj\n")

        page_ids = [10, 11, 12]
        content = b"BT /F1 24 Tf 56 760 Td (Gros fichier avec piece jointe) Tj ET"
        obj(1, b"<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(big.bin) 6 0 R] >> >> >>")
        obj(2, b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % i for i in page_ids) + b"] /Count 3 >>")
        obj(3, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
        obj(4, b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
        # pièce jointe
        objs.append((5, fh.tell()))
        fh.write(b"5 0 obj\n<< /Type /EmbeddedFile /Length %d >>\nstream\n" % size)
        chunk = os.urandom(8 * 1024 * 1024)
        written = 0
        while written < size:
            n = min(len(chunk), size - written)
            fh.write(chunk[:n])
            written += n
        fh.write(b"\nendstream\nendobj\n")
        obj(6, b"<< /Type /Filespec /F (big.bin) /UF (big.bin) /EF << /F 5 0 R >> >>")
        for pid in page_ids:
            obj(pid, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>")
        xref = fh.tell()
        allobjs = dict(objs)
        maxn = max(allobjs)
        fh.write(b"xref\n0 %d\n" % (maxn + 1))
        fh.write(b"0000000000 65535 f \n")
        for n in range(1, maxn + 1):
            if n in allobjs:
                fh.write(b"%010d 00000 n \n" % allobjs[n])
            else:
                fh.write(b"0000000000 65535 f \n")
        fh.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (maxn + 1, xref))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--big-gb", type=float, default=2.0)
    ap.add_argument("--skip-big", action="store_true")
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    j = lambda n: os.path.join(OUT, n)
    text_pages(j("01-texte-10p.pdf"), 10, "Texte simple")
    text_pages(j("02-texte-1000p.pdf"), 1000, "Mille pages")
    text_pages(j("03-courier-non-embarquee.pdf"), 3, "Police Courier", font="Courier")
    vector_transparency(j("04-vectoriel-transparence.pdf"))
    cjk(j("05-cjk-non-embarque.pdf"))
    scanned(j("06-scan-sans-texte.pdf"))
    mixed_sizes(j("07-tailles-mixtes-rotation.pdf"))
    form(j("08-formulaire-acroform.pdf"))
    encrypt(j("01-texte-10p.pdf"), j("09-chiffre-aes256.pdf"), "test1234")
    encrypt(j("08-formulaire-acroform.pdf"), j("10-formulaire-chiffre-aes256.pdf"), "test1234")
    if not a.skip_big:
        big_with_attachment(j("11-gros-fichier.pdf"), a.big_gb)
    for n in sorted(os.listdir(OUT)):
        print("%-36s %12d octets" % (n, os.path.getsize(j(n))))


if __name__ == "__main__":
    main()
