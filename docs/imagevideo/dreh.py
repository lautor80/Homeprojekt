#!/usr/bin/env python3
"""
Filmt docs/imagevideo/film.html Bild für Bild (Google Chrome über Playwright) und erzeugt daraus das Imagevideo.

  python3 docs/imagevideo/dreh.py bild 1:5.5 2:3.2      Standbilder (Szene:Sekunde) nach /tmp/imagevideo/bild-*.png
  python3 docs/imagevideo/dreh.py szene 0 3             nur diese Szenen neu filmen
  python3 docs/imagevideo/dreh.py film                  alle fehlenden Szenen filmen, zusammenfügen, Musik unterlegen

Jede Szene wird als eigene MP4 kodiert (gleiche Einstellungen), dann ohne Neukodierung aneinandergehängt.
Benötigt: Python-Paket playwright mit Google Chrome, ffmpeg, numpy/scipy (für musik.py), Schriften Inter und Inter Display.
"""
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

HIER = Path(__file__).resolve().parent
ARBEIT = Path('/tmp/imagevideo')
FPS = 30
ZIEL = HIER / 'TCO_Vereinsportal_Imagevideo.mp4'
ENC = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-r', str(FPS)]


def seite(p):
    browser = p.chromium.launch(channel='chrome')
    s = browser.new_page(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
    s.goto((HIER / 'film.html').as_uri())
    s.evaluate('document.fonts.ready')
    return browser, s


def bilder(paare):
    ARBEIT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser, s = seite(p)
        for paar in paare:
            i, t = paar.split(':')
            s.evaluate(f'window.seek({int(i)}, {float(t)})')
            ziel = ARBEIT / f'bild-{i}-{float(t):05.2f}.png'
            s.screenshot(path=str(ziel))
            print(ziel)
        browser.close()


def szene_filmen(s, i, dauer):
    n = round(dauer * FPS)
    tmp, ziel = ARBEIT / f'szene{i}.neu.mp4', ARBEIT / f'szene{i}.mp4'
    ff = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', str(FPS), '-c:v', 'mjpeg', '-i', '-', *ENC, str(tmp)],
                          stdin=subprocess.PIPE)
    for k in range(n):
        s.evaluate(f'window.seek({i}, {k / FPS})')
        ff.stdin.write(s.screenshot(type='jpeg', quality=92))
    ff.stdin.close()
    if ff.wait() != 0:
        raise SystemExit(f'ffmpeg-Fehler in Szene {i}')
    tmp.rename(ziel)
    print(f'Szene {i}: {n} Bilder → {ziel}', flush=True)


def szenen(welche=None, nur_fehlende=False):
    ARBEIT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser, s = seite(p)
        dauer = s.evaluate('window.film.dauer')
        for i, d in enumerate(dauer):
            if welche is not None and i not in welche:
                continue
            if nur_fehlende and (ARBEIT / f'szene{i}.mp4').exists():
                continue
            szene_filmen(s, i, d)
        browser.close()
    return dauer


def film():
    dauer = szenen(nur_fehlende=True)
    liste = ARBEIT / 'liste.txt'
    liste.write_text(''.join(f"file '{ARBEIT / f'szene{i}.mp4'}'\n" for i in range(len(dauer))))
    stumm, ton = ARBEIT / 'stumm.mp4', ARBEIT / 'musik.wav'
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(liste), '-c', 'copy', str(stumm)], check=True)
    subprocess.run([sys.executable, str(HIER / 'musik.py'), str(ton), *[str(d) for d in dauer]], check=True)
    tmp = ARBEIT / 'film.neu.mp4'
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', str(stumm), '-i', str(ton), '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
                    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', str(tmp)], check=True)
    tmp.rename(ZIEL)
    print(ZIEL)


if __name__ == '__main__':
    art, rest = (sys.argv[1] if len(sys.argv) > 1 else 'film'), sys.argv[2:]
    if art == 'bild':
        bilder(rest)
    elif art == 'szene':
        szenen({int(x) for x in rest})
    else:
        film()
