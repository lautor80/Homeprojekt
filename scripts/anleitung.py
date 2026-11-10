#!/usr/bin/env python3
"""
Erzeugt die gezeichneten Bilder (Übersicht der Wege, E-Mails) und die PDFs der Anwender-Anleitungen unter docs/anleitung.

Die übrigen Bilder unter docs/anleitung/bilder sind Bildschirmfotos des Portals mit erfundenen Personen; sie werden
hier nicht erzeugt (siehe docs/anleitung/README.md).

Aufruf:  python3 scripts/anleitung.py            (gezeichnete Bilder und PDFs)
         python3 scripts/anleitung.py --pdf      (nur PDFs aus den Markdown-Dateien)
Benötigt: Python-Paket playwright mit Google Chrome, pandoc.
"""
import html
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


PDF_CSS = """
@page{size:A4;margin:18mm 17mm 18mm}
body{font-family:'Inter',Arial,Helvetica,sans-serif;font-size:11.5pt;line-height:1.5;color:#1d2d3e;max-width:none}
h1{font-size:23pt;margin:0 0 4pt;color:#1d2d3e}
h2{font-size:16.5pt;color:#1d2d3e;border-bottom:1.5pt solid #d17e0a;padding-bottom:3pt;margin:0 0 10pt;break-after:avoid}
.kapitel{break-before:page}.kapitel.erste{break-before:auto;margin-top:18pt}
h3{font-size:12.5pt;margin:14pt 0 4pt;break-after:avoid}
p{margin:0 0 7pt}
img{display:block;margin:6pt auto 12pt;max-width:100%;max-height:165mm;border:.75pt solid #d5dadd;border-radius:5pt}
.schritt{break-inside:avoid}
.schritt:has(table){break-inside:auto}
img+ol,img+ul{break-before:avoid}
blockquote{margin:8pt 0;padding:7pt 11pt;background:#fdf4e6;border-left:3pt solid #d17e0a;border-radius:3pt;break-inside:avoid}
blockquote p:last-child{margin:0}
table{border-collapse:collapse;width:100%;margin:6pt 0 12pt;font-size:10.5pt;break-inside:avoid}
th,td{border:.75pt solid #c5cdd4;padding:5pt 7pt;text-align:left;vertical-align:top}
th{background:#eef2f5}
ul,ol{margin:0 0 8pt;padding-left:18pt}li{margin-bottom:2pt}
hr{border:0;border-top:.75pt solid #c5cdd4;margin:12pt 0}
code{font-family:inherit;background:#eef2f5;padding:0 3pt;border-radius:2pt}
"""


def bilder(seite):
    BILDER.mkdir(parents=True, exist_ok=True)
    for name, inhalt in seiten().items():
        seite.set_content(f'<!doctype html><html lang="de"><meta charset="utf-8"><style>{CSS}</style><body>{inhalt}</body></html>')
        seite.locator('.shot').screenshot(path=str(BILDER / f'{name}.png'))
        print('Bild', name)


def pdfs(browser):
    for md in sorted(ZIEL.glob('*.md')):
        if md.name == 'README.md':
            continue
        body = subprocess.run(['pandoc', '-f', 'gfm', '-t', 'html', str(md)], check=True, capture_output=True, text=True).stdout
        # Kapitel (h2) beginnen auf einer neuen Seite; Kapitelanfang und jeder Schritt (h3) bleiben mit Text und Bild zusammen
        kapitel = body.split('<h2')
        body = kapitel[0]
        for i, k in enumerate(kapitel[1:]):
            teile = ('<h2' + k).split('<h3')
            bloecke = [teile[0] + ('<h3' + teile[1] if len(teile) > 1 else '')] + ['<h3' + t for t in teile[2:]]
            body += f'<div class="kapitel{" erste" if i == 0 else ""}">' + ''.join(f'<div class="schritt">{b}</div>' for b in bloecke) + '</div>'
        seite = browser.new_page()
        seite.goto(md.as_uri())
        seite.set_content(f'<!doctype html><html lang="de"><meta charset="utf-8"><base href="{ZIEL.as_uri()}/"><style>{PDF_CSS}</style><body>{body}</body></html>',
                          wait_until='networkidle')
        seite.pdf(path=str(md.with_suffix('.pdf')), format='A4', print_background=True, display_header_footer=True,
                  header_template='<span></span>',
                  footer_template='<div style="font-size:8pt;color:#667;width:100%;text-align:center">Seite <span class="pageNumber"></span> von <span class="totalPages"></span></div>')
        seite.close()
        print('PDF ', md.with_suffix('.pdf').name)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome')
        if '--pdf' not in sys.argv:
            seite = browser.new_page(viewport={'width': 1000, 'height': 800}, device_scale_factor=2)
            bilder(seite)
            seite.close()
        pdfs(browser)
        browser.close()


if __name__ == '__main__':
    main()
