#!/usr/bin/env python3
"""
Erzeugt die gezeichneten Bilder (Übersicht der Wege, E-Mails) und die PDFs der Anwender-Anleitungen unter docs/anleitung.

Die übrigen Bilder unter docs/anleitung/bilder sind Bildschirmfotos des Portals mit erfundenen Personen; sie werden
hier nicht erzeugt (siehe docs/anleitung/README.md).

Aufruf:  python3 scripts/anleitung.py            (gezeichnete Bilder und PDFs)
         python3 scripts/anleitung.py --pdf      (nur PDFs aus den Markdown-Dateien)
         python3 scripts/anleitung.py --pdf hallenbuchung   (nur diese Anleitung)
Benötigt: Python-Paket playwright mit Google Chrome, pandoc.
"""
import html
import re
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ZIEL = Path(__file__).resolve().parent.parent / 'docs' / 'anleitung'
BILDER = ZIEL / 'bilder'

VEREIN = 'TC Oberthal'
PORTAL = 'https://vereinsportal.example'
M = dict(vor='Martina', nach='Muster', mail='martina.muster@beispiel.example', user='martina.muster',
         strasse='Ahornweg 12', plz='12345', ort='Musterhausen', geb='14.03.1985', nr='4711', tel='')
H = dict(vor='Hannes', nach='Beispiel', mail='hannes.beispiel@beispiel.example', user='hannes.beispiel',
         strasse='Lindenstraße 7', plz='54321', ort='Beispielstadt', tel='0151 0000000')

CSS = """
*{box-sizing:border-box}
html,body{margin:0}
body{font-family:'72','Inter',Arial,Helvetica,sans-serif;font-size:14px;color:#1d2d3e;-webkit-font-smoothing:antialiased}
/* E-Mail */
.mailwrap{width:640px;padding:1.5rem;background:#e8ecf0}
.mail{background:#fff;border-radius:.6rem;box-shadow:0 .25rem 1rem rgba(0,0,0,.12);overflow:hidden}
.mailkopf{padding:1rem 1.25rem;border-bottom:1px solid #e2e6ea;background:#fafbfc}
.mailkopf b{font-size:1.05rem;display:block;margin-bottom:.4rem}
.mailkopf span{display:block;color:#556b82;font-size:.8rem;line-height:1.5}
.mailtext{padding:1.1rem 1.25rem 1.25rem;line-height:1.55;white-space:pre-wrap;position:relative}
.mailtext .link{position:relative;word-break:break-all;background:#fdecea;outline:2px solid #d32f2f;outline-offset:2px;border-radius:2px}
.anhang{margin:0 1.25rem 1.25rem;padding:.5rem .75rem;border:1px solid #d5dadd;border-radius:.4rem;display:inline-flex;gap:.6rem;align-items:center;color:#556b82;font-size:.8rem}
.qr{width:2.2rem;height:2.2rem;background:
  linear-gradient(#1d2d3e,#1d2d3e) 0 0/.7rem .7rem no-repeat,linear-gradient(#1d2d3e,#1d2d3e) 100% 0/.7rem .7rem no-repeat,
  linear-gradient(#1d2d3e,#1d2d3e) 0 100%/.7rem .7rem no-repeat,
  repeating-conic-gradient(#1d2d3e 0 25%,#fff 0 50%) 50% 50%/.44rem .44rem}
/* Übersicht */
.wege{width:900px;padding:1.5rem;background:#fff;display:flex;gap:1rem}
.weg{flex:1;border:1px solid #d5dadd;border-radius:.75rem;padding:1rem;background:#f9fafb}
.weg h2{margin:0 0 .25rem;font-size:1.05rem;color:#a35f00}
.weg .wann{color:#556b82;font-size:.85rem;min-height:3.4em;line-height:1.35;margin-bottom:.75rem}
.weg ol{margin:0;padding:0;list-style:none;counter-reset:s}
.weg li{counter-increment:s;background:#fff;border:1px solid #d5dadd;border-radius:.5rem;padding:.5rem .6rem .5rem 2.3rem;margin-bottom:.9rem;position:relative;line-height:1.35}
.weg li::before{content:counter(s);position:absolute;left:.55rem;top:.5rem;width:1.3rem;height:1.3rem;border-radius:50%;background:#d17e0a;color:#fff;font-weight:700;font-size:.75rem;display:grid;place-items:center}
.weg li:not(:last-child)::after{content:'▼';position:absolute;left:50%;bottom:-.9rem;font-size:.6rem;color:#8396a8}
.weg li.ziel{background:#f5fae5;border-color:#30914c}.weg li.ziel::before{content:'✓';background:#256f3a}
.dauer{margin-top:.25rem;font-size:.8rem;color:#556b82;text-align:center}
"""

e = html.escape


def mail(betreff, an, inhalt, anhang=None):
    """inhalt: Text; der Abschnitt zwischen [[ und ]] wird als Link hervorgehoben."""
    t = e(inhalt).replace('[[', '<span class="link">').replace(']]', '</span>')
    a = f'<div class="anhang"><div class="qr"></div>{e(anhang)}</div>' if anhang else ''
    return (f'<div class="mailwrap shot"><div class="mail"><div class="mailkopf"><b>{e(betreff)}</b>'
            f'<span>Von: {e(VEREIN)}</span><span>An: {e(an)}</span></div><div class="mailtext">{t}</div>{a}</div></div>')


def wege(*spalten):
    out = '<div class="wege shot">'
    for titel, wann, schritte, dauer in spalten:
        li = ''.join(f'<li class="{"ziel" if i == len(schritte) - 1 else ""}">{e(s)}</li>' for i, s in enumerate(schritte))
        out += f'<div class="weg"><h2>{e(titel)}</h2><div class="wann">{e(wann)}</div><ol>{li}</ol><div class="dauer">{e(dauer)}</div></div>'
    return out + '</div>'


def kennwort_mail(p, anrede):
    return mail(f'{VEREIN}: Kennwort zurücksetzen', p['mail'],
        f'Guten Tag {anrede},\n\nfür Ihren Zugang (Benutzer {p["user"]}) wurde das Zurücksetzen des Kennworts angefordert. '
        f'Über diesen Link vergeben Sie ein neues Kennwort (gültig 60 Minuten, nur einmal verwendbar):\n\n[[{PORTAL}/?kennwort=…]]\n\n'
        f'Haben Sie das nicht angefordert, können Sie diese E-Mail ignorieren – Ihr bisheriges Kennwort bleibt gültig.\n\nViele Grüße\n{VEREIN}')


def seiten():
    """Texte der E-Mails wie im Portal (server/src/kennwort.ts, modules/tco/server)."""
    s = {}
    s['m-wege'] = wege(
        ('Weg A: Einladung', 'Sie haben vom Verein eine E-Mail oder einen Brief mit QR-Code bekommen.',
         ['Link anklicken oder QR-Code scannen', 'Benutzername und Kennwort wählen', 'Sofort anmelden'], 'Dauer: etwa 2 Minuten'),
        ('Weg B: Schnellweg', 'Sie haben keine Einladung. Der Verein kennt aber Ihre E-Mail-Adresse.',
         ['Auf der Anmeldeseite „registrieren“ wählen', 'E-Mail und Geburtsdatum eingeben', 'Link in der E-Mail anklicken', 'Benutzername und Kennwort wählen', 'Sofort anmelden'], 'Dauer: etwa 5 Minuten'),
        ('Weg C: Vollständige Registrierung', 'Der Schnellweg findet Sie nicht, oder der Verein hat keine E-Mail-Adresse von Ihnen.',
         ['Auf der Anmeldeseite „registrieren“ wählen', 'Formular ausfüllen und absenden', 'Der Verein prüft Ihre Mitgliedschaft', 'Sie bekommen eine E-Mail', 'Anmelden'], 'Dauer: Formular 5 Minuten, dann warten auf den Verein'),
    )
    s['m-a-1-mail'] = mail(f'{VEREIN}: Ihr Zugang zum Vereinsportal', M['mail'],
        f'Hallo {M["vor"]},\n\nim Vereinsportal des {VEREIN} sehen und pflegen Sie Ihre Mitgliedsdaten, buchen Hallen- und Freiplätze, '
        'melden sich zu Veranstaltungen an und erfassen Ihren Clubhaus-Verzehr.\n\n'
        'Ihr persönlicher Zugang ist vorbereitet. Über diesen Link (oder den QR-Code im Anhang) wählen Sie Benutzername und Kennwort – fertig:\n\n'
        f'[[{PORTAL}/einladung?token=…]]\n\nDer Link gilt bis 10.12.2026, 09:00 und nur für Sie. Bitte nicht weitergeben.\n\nViele Grüße\n{VEREIN}',
        anhang='Zugang-QR-Code.png')
    s['m-c-5-freigabe'] = mail(f'{VEREIN}: Ihr Zugang ist freigeschaltet', M['mail'],
        f'Guten Tag {M["vor"]} {M["nach"]},\n\nIhr Zugang zum Portal ist freigeschaltet. Sie können sich jetzt unter [[{PORTAL}]] anmelden '
        '– mit Ihrem Benutzernamen und dem bei der Registrierung gewählten Kennwort.\n\n'
        f'Als Mitglied sehen Sie unter „Meine Mitgliedschaft“ Ihre Daten, buchen Plätze und erfassen Ihren Clubhaus-Verzehr.\n\nViele Grüße\n{VEREIN}')
    s['m-pw-4-mail'] = kennwort_mail(M, f'{M["nach"]}, {M["vor"]}')
    s['h-5-mail'] = mail(f'{VEREIN}: Bitte bestätigen Sie Ihre Registrierung', H['mail'],
        f'Guten Tag {H["vor"]} {H["nach"]},\n\nvielen Dank für Ihre Registrierung (Benutzername {H["user"]}). '
        f'Bitte bestätigen Sie Ihre E-Mail-Adresse über diesen Link (24 Stunden gültig):\n\n[[{PORTAL}/registrierung-bestaetigen?token=…]]\n\n'
        'Danach ist Ihr Zugang sofort freigeschaltet und Sie können Hallen- und Freiplätze buchen.\n\n'
        f'Haben Sie sich nicht registriert, ignorieren Sie diese E-Mail – ohne Bestätigung wird nichts angelegt.\n\nViele Grüße\n{VEREIN}')
    s['h-pw-4-mail'] = kennwort_mail(H, f'{H["vor"]} {H["nach"]}')
    return s


# Vereinslayout wie die PDFs des Portals (modules/tco/server/pdf/layout.ts, z. B. Einnahmen-Ausgaben-Rechnung):
# orangefarbenes Kopfband mit weißem Logo auf der ersten Seite, Folgekopf mit orangefarbener Linie, Karten mit grauem Rand,
# Zwischenüberschriften in Großbuchstaben, Fußband mit orangefarbener Linie und Seitenzahl.
FARBE = dict(orange='#E2701F', orangeDk='#B9561A', orangeSoft='#FDF0E6', ink='#1F1F1F', grau='#6B6B6B', linie='#E3E3E3',
             rand='#C8C8C8', fuss='#F6F4F2')
LOGO = Path(__file__).resolve().parent.parent / 'modules' / 'tco' / 'server' / 'assets' / 'logo_weiss.png'
SCHRIFT = "Helvetica,'Liberation Sans',Arial,sans-serif"
PDF_CSS = f"""
@page{{size:A4;margin:24mm 18mm 25mm;
  @top-left{{content:"__TITEL__";font:700 9pt {SCHRIFT};color:{FARBE['ink']};vertical-align:bottom;padding-bottom:1.5mm;border-bottom:.6mm solid {FARBE['orange']}}}
  @top-center{{content:"";vertical-align:bottom;padding-bottom:1.5mm;border-bottom:.6mm solid {FARBE['orange']}}}
  @top-right{{content:"{VEREIN}";font:8pt {SCHRIFT};color:{FARBE['grau']};vertical-align:bottom;padding-bottom:1.5mm;border-bottom:.6mm solid {FARBE['orange']}}}}}
/* Deckblatt (Seite 1): randlos für das Kopfband, Vorspann mit eigenem Seitenrand */
@page deckblatt{{margin:0 0 25mm;@top-left{{content:none;border:0}}@top-center{{content:none;border:0}}@top-right{{content:none;border:0}}}}
.deckblatt{{page:deckblatt}}
.vorspann{{padding:0 18mm}}
body{{font-family:{SCHRIFT};font-size:10pt;line-height:1.48;color:{FARBE['ink']};margin:0}}
.band{{position:relative;width:100%;height:46mm;background:{FARBE['orange']};color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.band .titel{{position:absolute;left:18mm;top:22mm;font-size:22pt;line-height:1.1;max-width:112mm}}
.band .zeile{{position:absolute;left:18mm;top:35mm;font-size:10pt}}
.band img{{position:absolute;left:137mm;top:5.6mm;width:57mm;height:34.7mm;border:0;border-radius:0;margin:0;object-fit:contain}}
.nachband{{height:10mm}}
h1{{display:none}}
h2{{font-size:15pt;font-weight:700;color:{FARBE['ink']};border-bottom:.6mm solid {FARBE['orange']};padding-bottom:2.5pt;margin:0 0 9pt;break-after:avoid}}
.kapitel{{break-before:page}}
h3{{font-size:8.5pt;font-weight:700;text-transform:uppercase;letter-spacing:.3pt;color:{FARBE['orangeDk']};margin:13pt 0 4pt;break-after:avoid}}
p{{margin:0 0 6.5pt}}
strong{{color:{FARBE['ink']}}}
img{{display:block;box-sizing:border-box;margin:6pt auto 12pt;max-width:100%;max-height:160mm;border:.3mm solid {FARBE['rand']};border-radius:3mm}}
.schritt{{break-inside:avoid}}
.schritt:has(table){{break-inside:auto}}
img+ol,img+ul{{break-before:avoid}}
blockquote{{margin:8pt 0 10pt;padding:7pt 11pt;background:{FARBE['orangeSoft']};border:.3mm solid {FARBE['rand']};border-radius:3mm;break-inside:avoid;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}}
blockquote p:last-child,blockquote ul:last-child{{margin-bottom:0}}
table{{border-collapse:separate;border-spacing:0;width:100%;margin:6pt 0 12pt;font-size:9pt;break-inside:avoid;border:.3mm solid {FARBE['rand']};border-radius:3mm;overflow:hidden}}
th,td{{padding:5pt 8pt;text-align:left;vertical-align:top;border-bottom:.2mm solid {FARBE['linie']}}}
tr:last-child td{{border-bottom:0}}
th{{font-size:7.5pt;font-weight:400;color:{FARBE['grau']};border-bottom:.3mm solid {FARBE['linie']}}}
ul,ol{{margin:0 0 8pt;padding-left:16pt}}li{{margin-bottom:2pt}}
ol li::marker{{color:{FARBE['orangeDk']};font-weight:700}}
hr{{border:0;border-top:.3mm solid {FARBE['linie']};margin:12pt 0}}
code{{font-family:inherit;background:{FARBE['fuss']};padding:0 3pt;border-radius:2pt}}
"""


def kopf_fuss(titel):
    """Folgekopf (ab Seite 2; auf Seite 1 hat der Rand oben die Höhe 0) und Fußband im Vereinslayout"""
    f = FARBE
    stil = '<style>*{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>'
    kopf = (f'{stil}<div style="width:100%;margin:0 18mm;padding-top:7mm;font-family:{SCHRIFT};display:flex;justify-content:space-between;'
            f'align-items:flex-end;border-bottom:.6mm solid {f["orange"]};padding-bottom:1.5mm">'
            f'<span style="font-size:9pt;font-weight:700;color:{f["ink"]}">{e(titel)}</span>'
            f'<span style="font-size:8pt;color:{f["grau"]}">{e(VEREIN)}</span></div>')
    fuss = (f'{stil}<div style="width:100%;font-family:{SCHRIFT};margin:0">'
            f'<div style="text-align:right;font-size:7pt;color:{f["grau"]};padding:0 18mm 2.5mm">Seite <span class="pageNumber"></span> von <span class="totalPages"></span></div>'
            f'<div style="height:1mm;background:{f["orange"]}"></div>'
            f'<div style="background:{f["fuss"]};height:14mm;display:flex;justify-content:space-between;align-items:center;padding:0 18mm;font-size:7pt;color:{f["grau"]}">'
            f'<span>{e(VEREIN)} · Vereinsportal</span><span>{e(titel)}</span></div></div>')
    return kopf, fuss


def bilder(seite):
    BILDER.mkdir(parents=True, exist_ok=True)
    for name, inhalt in seiten().items():
        seite.set_content(f'<!doctype html><html lang="de"><meta charset="utf-8"><style>{CSS}</style><body>{inhalt}</body></html>')
        seite.locator('.shot').screenshot(path=str(BILDER / f'{name}.png'))
        print('Bild', name)


def pdfs(browser, nur=None):
    for md in sorted(ZIEL.glob('*.md')):
        if md.name == 'README.md' or (nur and md.stem not in nur):
            continue
        body = subprocess.run(['pandoc', '-f', 'gfm', '-t', 'html', str(md)], check=True, capture_output=True, text=True).stdout
        # Titel (h1 „Titel – Zusatz“) ins Kopfband
        h1 = re.search(r'<h1[^>]*>(.*?)</h1>', body, re.S)
        titel_html = h1.group(1) if h1 else md.stem
        titel_text = ' '.join(html.unescape(re.sub(r'<[^>]+>', '', titel_html)).split())
        haupt, _, zusatz = titel_text.partition(' – ')
        band = (f'<div class="band"><img src="{LOGO.as_uri()}" alt=""><div class="titel">{e(haupt)}</div>'
                f'<div class="zeile">{e(zusatz or "Anleitung")} · {e(VEREIN)}</div></div><div class="nachband"></div>')
        # Deckblatt: Kopfband, Einleitung, „Gut zu wissen“ und Inhalt; jedes Kapitel beginnt danach auf einer neuen Seite
        # Kapitel (h2) beginnen auf einer neuen Seite; Kapitelanfang und jeder Schritt (h3) bleiben mit Text und Bild zusammen
        kapitel = body.split('<h2')
        body = f'<div class="deckblatt">{band}<div class="vorspann">{kapitel[0]}</div></div>'
        for i, k in enumerate(kapitel[1:]):
            teile = ('<h2' + k).split('<h3')
            bloecke = [teile[0] + ('<h3' + teile[1] if len(teile) > 1 else '')] + ['<h3' + t for t in teile[2:]]
            body += f'<div class="kapitel{" erste" if i == 0 else ""}">' + ''.join(f'<div class="schritt">{b}</div>' for b in bloecke) + '</div>'
        _, fuss = kopf_fuss(haupt)
        seite = browser.new_page()
        seite.goto(md.as_uri())
        seite.set_content(f'<!doctype html><html lang="de"><meta charset="utf-8"><title>{e(titel_text)}</title><base href="{ZIEL.as_uri()}/">'
                          f'<style>{PDF_CSS.replace("__TITEL__", haupt.replace(chr(34), ""))}</style>'
                          f'<body>{body}</body></html>', wait_until='networkidle')
        seite.pdf(path=str(md.with_suffix('.pdf')), print_background=True, display_header_footer=True, prefer_css_page_size=True,
                  header_template='<span></span>', footer_template=fuss)
        seite.close()
        print('PDF ', md.with_suffix('.pdf').name)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome')
        if '--pdf' not in sys.argv:
            seite = browser.new_page(viewport={'width': 1000, 'height': 800}, device_scale_factor=2)
            bilder(seite)
            seite.close()
        # einzelne Anleitungen: Dateinamen ohne Endung, z. B. „--pdf hallenbuchung“
        pdfs(browser, [a for a in sys.argv[1:] if not a.startswith('--')] or None)
        browser.close()


if __name__ == '__main__':
    main()
