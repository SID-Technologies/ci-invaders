#!/usr/bin/env python3
"""Synthesise CI Invaders' sound clips: short, soft tones, so the plugin ships no
third-party audio. Run from the repo root: python3 scripts/make-sounds.py"""

import math
import struct
import wave

RATE = 44_100


def tone(freq, seconds, gain=0.25, decay=6.0):
    """A sine with a quick attack and an exponential tail."""
    n = int(RATE * seconds)
    out = []
    for i in range(n):
        t = i / RATE
        attack = min(1.0, t / 0.008)
        out.append(gain * attack * math.exp(-decay * t) * math.sin(2 * math.pi * freq * t))
    return out


def mix(*parts):
    """Lay clips over one another, each at its offset in seconds."""
    length = max(int(off * RATE) + len(p) for off, p in parts)
    out = [0.0] * length
    for off, p in parts:
        start = int(off * RATE)
        for i, s in enumerate(p):
            out[start + i] += s
    return out


def write(path, samples):
    peak = max(1e-9, max(abs(s) for s in samples))
    scale = min(1.0, 0.9 / peak)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(s * scale * 32767)) for s in samples))


C5, E5, G5, C6 = 523.25, 659.25, 783.99, 1046.5

write("assets/sounds/green.wav", mix((0, tone(E5, 0.35)), (0.09, tone(G5, 0.45))))
write("assets/sounds/failed.wav", mix((0, tone(196.0, 0.5, decay=7)), (0.0, tone(98.0, 0.5, gain=0.35, decay=8))))
write("assets/sounds/merged.wav", mix((0, tone(C5, 0.4)), (0.08, tone(E5, 0.4)), (0.16, tone(G5, 0.4)), (0.24, tone(C6, 0.6))))
write(
    "assets/sounds/released.wav",
    [0.22 * math.exp(-2.5 * (i / RATE)) * math.sin(2 * math.pi * (300 + 900 * (i / RATE)) * (i / RATE)) for i in range(int(RATE * 0.9))],
)
