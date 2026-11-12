#!/usr/bin/env python3
"""
Musik zum Imagevideo – vollständig errechnet (keine fremden Aufnahmen, keine Lizenzfragen).

  python3 musik.py ziel.wav 5 10 10 10 10 10 7.5      (Szenendauern in Sekunden)

96 Schläge je Minute: ein Takt dauert 2,5 s, eine 10-Sekunden-Szene also genau vier Takte (D – A – h – G).
Auftakt ohne Schlagwerk, ab der ersten Szene mit Bass und leichtem Rhythmus, zum Schlussbild ein ausklingender Akkord.
"""
import sys
import wave

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100
BPM = 96
SCHLAG = 60 / BPM
TAKT = 4 * SCHLAG
ACHTEL = SCHLAG / 2
rng = np.random.default_rng(153)

hz = lambda m: 440.0 * 2 ** ((m - 69) / 12)

AKKORDE = {
    'D': dict(bass=38, flaeche=[50, 57, 62, 66], arp=[62, 66, 69, 74], melodie=[81, None, 78, None, 76, 78, None, None]),
    'A': dict(bass=45, flaeche=[49, 57, 61, 64], arp=[61, 64, 69, 73], melodie=[76, None, 73, None, 76, None, 81, None]),
    'h': dict(bass=47, flaeche=[47, 54, 59, 62], arp=[59, 62, 66, 71], melodie=[78, None, 74, None, 78, 81, None, None]),
    'G': dict(bass=43, flaeche=[43, 55, 59, 62], arp=[59, 62, 67, 71], melodie=[79, None, 78, None, 74, None, 71, None]),
}
FOLGE = ['D', 'A', 'h', 'G']
MUSTER = [[0, 2, 1, 2, 3, 2, 1, 2], [0, 1, 2, 3, 2, 1, 2, 1], [0, 2, 3, 2, 1, 2, 3, 2]]


class Spur:
    def __init__(self, sekunden):
        self.x = np.zeros((int(sekunden * SR) + SR * 4, 2))

    def dazu(self, t, ton, pegel=1.0, lage=0.0):
        """ton: Mono-Array; lage -1 (links) … 1 (rechts)"""
        a = int(t * SR)
        if a < 0 or a >= len(self.x):
            return
        ton = ton[:len(self.x) - a]
        l, r = np.cos((lage + 1) * np.pi / 4), np.sin((lage + 1) * np.pi / 4)
        self.x[a:a + len(ton), 0] += ton * pegel * l
        self.x[a:a + len(ton), 1] += ton * pegel * r


def zupf(m, dauer=1.1, hell=1.0):
    """weicher, marimbaartiger Ton"""
    t = np.arange(int(dauer * SR)) / SR
    f = hz(m)
    y = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.32)
    y += 0.38 * hell * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t / 0.12)
    y += 0.14 * hell * np.sin(2 * np.pi * 4.02 * f * t) * np.exp(-t / 0.05)
    return y * np.minimum(1, t / 0.004)


def flaeche(noten, dauer):
    t = np.arange(int((dauer + 1.2) * SR)) / SR
    y = np.zeros_like(t)
    for m in noten:
        f = hz(m)
        for v in (-0.35, 0.35):
            y += np.sin(2 * np.pi * f * (1 + v / 100) * t + rng.uniform(0, 6.28))
        y += 0.25 * np.sin(2 * np.pi * 2 * f * t + rng.uniform(0, 6.28))
    huelle = np.minimum(1, t / 0.7) * np.minimum(1, np.maximum(0, (dauer + 1.2 - t) / 1.2))
    return y / (len(noten) * 2.25) * huelle * (1 + 0.08 * np.sin(2 * np.pi * 0.4 * t))


def bass(m, dauer):
    t = np.arange(int(dauer * SR)) / SR
    f = hz(m)
    y = np.sin(2 * np.pi * f * t) + 0.45 * np.sin(2 * np.pi * 2 * f * t) + 0.12 * np.sin(2 * np.pi * 3 * f * t)
    return y * np.minimum(1, t / 0.008) * np.exp(-t / (dauer * 0.55)) * np.minimum(1, (dauer - t) / 0.03)


def kick():
    t = np.arange(int(0.28 * SR)) / SR
    f = 48 + 90 * np.exp(-t / 0.035)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.09) * np.minimum(1, t / 0.002)


def rauschen(dauer, tief, hoch, abkling):
    t = np.arange(int(dauer * SR)) / SR
    y = sosfilt(butter(2, [tief, hoch], btype='band', fs=SR, output='sos'), rng.standard_normal(len(t)))
    return y * np.exp(-t / abkling) * np.minimum(1, t / 0.001)


def wisch(dauer=0.9):
    """leises Anschwellen zum Szenenwechsel"""
    t = np.arange(int(dauer * SR)) / SR
    y = sosfilt(butter(2, [900, 6000], btype='band', fs=SR, output='sos'), rng.standard_normal(len(t)))
    return y * np.sin(np.pi * t / dauer) ** 3


def hall(x, nass=0.24, dauer=1.7):
    t = np.arange(int(dauer * SR)) / SR
    aus = np.zeros((len(x) + len(t) - 1, 2))
    for k in range(2):
        ir = sosfilt(butter(2, 5200, btype='low', fs=SR, output='sos'), rng.standard_normal(len(t))) * np.exp(-t / 0.42)
        ir[:int(0.012 * SR)] = 0
        aus[:, k] = fftconvolve(x[:, k], ir / np.sqrt(np.sum(ir ** 2)))
    return x + nass * aus[:len(x)]


def bauen(dauern):
    gesamt = sum(dauern)
    takte = round(gesamt / TAKT)
    grenzen = np.cumsum(dauern)[:-1]
    auftakt = round(dauern[0] / TAKT)                 # Takte ohne Schlagwerk
    schluss = takte - 1                               # letzter Takt: Schlussakkord
    klang, trocken = Spur(gesamt), Spur(gesamt)       # klang bekommt Hall, trocken nicht
    tsch, tk, rim = rauschen(0.09, 6000, 12000, 0.022), kick(), rauschen(0.12, 1500, 4500, 0.03)

    for n in range(takte):
        t0 = n * TAKT
        if n < auftakt:
            name = ['D', 'G'][n % 2]
        elif n >= schluss - 2:
            name = ['D', 'G', 'D'][n - (schluss - 2)]
        else:
            name = FOLGE[(n - auftakt) % 4]
        a = AKKORDE[name]
        szene = int(np.searchsorted(grenzen, t0 + 1e-6, side='right'))
        klang.dazu(t0, flaeche(a['flaeche'], TAKT), 0.30)

        if n == schluss:                              # Schlussakkord: breit gezupft, klingt aus
            for k, m in enumerate([50, 57, 62, 66, 69, 74, 78]):
                klang.dazu(t0 + k * 0.035, zupf(m, 2.4), 0.30, lage=(k - 3) / 5)
            trocken.dazu(t0, bass(38, 2.2), 0.50)
            trocken.dazu(t0, tk, 0.55)
            continue

        if n < auftakt:                               # Auftakt: ruhige Viertel
            for k in range(4):
                klang.dazu(t0 + k * SCHLAG, zupf(a['arp'][[0, 2, 1, 3][k]] + 12, 1.4), 0.20 + 0.03 * k, lage=(-0.3, 0.3)[k % 2])
            continue

        muster = MUSTER[szene % len(MUSTER)]
        for k in range(8):                            # Achtel-Figur
            laut = 0.23 if k % 2 == 0 else 0.16
            klang.dazu(t0 + k * ACHTEL + rng.uniform(-0.004, 0.004), zupf(a['arp'][muster[k]], 0.9), laut * rng.uniform(0.9, 1.05),
                       lage=(-0.35, 0.35)[k % 2])
        if szene in (2, 3, 5, 6):                     # Melodie in der Oktave darüber
            for k, m in enumerate(a['melodie']):
                if m:
                    klang.dazu(t0 + k * ACHTEL, zupf(m, 1.3, hell=0.6), 0.15, lage=0.12)
        for k, d in ((0, 1.5), (3, 0.5), (5, 1.5)):   # Bass
            trocken.dazu(t0 + k * ACHTEL, bass(a["bass"], d * SCHLAG), 0.34)
        for k in (0, 2):                              # Schlagwerk
            trocken.dazu(t0 + k * SCHLAG, tk, 0.42)
        if szene != 4:
            for k in (1, 3):
                klang.dazu(t0 + k * SCHLAG, rim, 0.10, lage=0.2)
        for k in range(8):
            trocken.dazu(t0 + k * ACHTEL, tsch, 0.035 if k % 2 == 0 else 0.06, lage=-0.25)

    for g in grenzen:                                 # Szenenwechsel
        klang.dazu(g - 0.62, wisch(), 0.05)

    x = hall(klang.x) + trocken.x
    x = x[:int(gesamt * SR)]
    aus = int(1.3 * SR)                               # ausblenden
    x[-aus:] *= np.linspace(1, 0, aus)[:, None] ** 1.5
    x[:int(0.05 * SR)] *= np.linspace(0, 1, int(0.05 * SR))[:, None]
    x = np.tanh(x * 1.15)
    return x / np.max(np.abs(x)) * 10 ** (-1.5 / 20)


if __name__ == '__main__':
    ziel, dauern = sys.argv[1], [float(d) for d in sys.argv[2:]] or [5, 10, 10, 10, 10, 10, 7.5]
    x = bauen(dauern)
    with wave.open(ziel, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype('<i2').tobytes())
    print(f'{ziel}: {len(x) / SR:.2f} s, Spitze {20 * np.log10(np.max(np.abs(x))):.1f} dBFS, RMS {20 * np.log10(np.sqrt(np.mean(x ** 2))):.1f} dBFS')
