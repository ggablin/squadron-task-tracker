"""
108 CES UTA Tracker app icon.

Inspired by the USAF Civil Engineering "Prime BEEF" emblem, not a copy of it.
The charging bull is the only element that survives at 192px, so it is kept and
everything else — the two text rings, the fine cyan linework, the "PRIME BEEF"
wordmark — is dropped. The cloud bank stays, reduced to a few lobes: it is what
the bull emerges from, and it survives the downsample. An interpretation also avoids the usage
questions that come with reproducing an official DoD emblem.

Horns are built by offsetting a centreline with a taper (thick at the skull,
a point at the tip) rather than by guessing two edge curves, which is what made
earlier passes look like bat wings.

Everything is drawn at 2048 and downsampled with LANCZOS — there is no SVG
rasterizer on this machine, and supersampling beats PIL's own antialiasing.
Design space is 2000x2000, centre (1000,1000); artwork is auto-scaled about the
centre so it can never break the ring.
"""
from PIL import Image, ImageDraw
import os, sys, math

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
S = 2048
os.makedirs(OUT, exist_ok=True)

GOLD  = (242, 193, 46, 255)     # CE gold, warmed to sit with the app palette
INK   = (26, 24, 22, 255)       # --bg dark: warm near-black
CREAM = (246, 247, 237, 255)    # --cream
TERRA = (168, 71, 47, 255)      # --urgent

FIELD_R = 930.0
SAFE_R  = 862.0
ART_SCALE = 1.16   # fill the field; FIT clamps if this overreaches
C = 1000.0


def bez(p0, p1, p2, n=120):
    o = []
    for i in range(n + 1):
        t = i / n; u = 1 - t
        o.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                  u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
    return o


def taper(centre, w0, w1, round_base=True):
    """Offset a centreline into a closed tapered shape: width w0 -> w1."""
    n = len(centre)
    a, b = [], []
    for i, (x, y) in enumerate(centre):
        t = i / (n - 1)
        w = (w0 + (w1 - w0) * (t ** 0.85)) / 2.0
        if i == 0:
            dx, dy = centre[1][0] - x, centre[1][1] - y
        elif i == n - 1:
            dx, dy = x - centre[-2][0], y - centre[-2][1]
        else:
            dx = centre[i + 1][0] - centre[i - 1][0]
            dy = centre[i + 1][1] - centre[i - 1][1]
        L = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / L, dx / L
        a.append((x + nx * w, y + ny * w))
        b.append((x - nx * w, y - ny * w))
    if round_base:   # square the base off inside the skull
        a = [(a[0][0], a[0][1])] + a
    return a + b[::-1]


def mirror(pts):
    return [(2 * C - x, y) for (x, y) in pts]


# ── the mark, as ops in design space ────────────────────────────────────────
def build():
    ops = []

    # Snort: two clustered billows, lobes of uneven size so they read as puffs
    # rather than the row of evenly spaced beads an earlier pass produced.
    for (x, y, r) in [(1000, 1596, 104), (846, 1548, 128), (1154, 1548, 128),
                      (676, 1580, 96), (1324, 1580, 96), (556, 1614, 66),
                      (1444, 1614, 66), (742, 1476, 68), (1258, 1476, 68)]:
        ops.append(("circle", (x, y, r), CREAM))

    # Ears: below and behind the horns, drooping out and down the way a bull's
    # actually sit. Higher up they read as bolts, or as a second pair of horns.
    for s in (1, -1):
        e = taper(bez((820, 1120), (704, 1216), (628, 1258), 44), 132, 34)
        ops.append(("poly", e if s == 1 else mirror(e), INK))

    # Horns: out from the skull, dipping, then hooking up to a point.
    for s in (1, -1):
        centre = bez((862, 900), (516, 892), (392, 588), 90)
        h = taper(centre, 152, 8)
        ops.append(("poly", h if s == 1 else mirror(h), INK))

    # Skull: domed brow, full cheeks, a clear step in to a broad muzzle.
    head = (
        bez((788, 880), (1000, 706), (1212, 880))
        + bez((1212, 880), (1300, 1030), (1252, 1180))
        + bez((1252, 1180), (1216, 1276), (1140, 1318))
        + bez((1140, 1318), (1186, 1424), (1124, 1506))
        + bez((1124, 1506), (1000, 1588), (876, 1506))
        + bez((876, 1506), (814, 1424), (864, 1316))
        + bez((864, 1316), (796, 1272), (768, 1180))
        + bez((768, 1180), (700, 1030), (788, 880))
    )
    ops.append(("poly", head, INK))

    # Brow ridge: shallow and wide, a suggestion of the forelock.
    for (x, y, r) in [(898, 800, 56), (1000, 776, 62), (1102, 800, 56)]:
        ops.append(("circle", (x, y, r), INK))

    # Nostrils, punched back out in gold.
    for x in (932, 1068):
        ops.append(("ellipse", (x, 1378, 36, 25), GOLD))
    return ops


def extent(ops):
    worst = 0.0
    for kind, geom, _ in ops:
        if kind == "poly":
            for (x, y) in geom:
                worst = max(worst, math.hypot(x - C, y - C))
        elif kind == "circle":
            x, y, r = geom
            worst = max(worst, math.hypot(x - C, y - C) + r)
        else:
            x, y, rx, ry = geom
            worst = max(worst, math.hypot(x - C, y - C) + max(rx, ry))
    return worst


def render_ops(d, ops, k, fit):
    def P(x, y):
        return ((C + (x - C) * fit) * k, (C + (y - C) * fit) * k)
    for kind, geom, col in ops:
        if kind == "poly":
            d.polygon([P(x, y) for (x, y) in geom], fill=col)
        elif kind == "circle":
            x, y, r = geom; r *= fit
            cx, cy = P(x, y)
            d.ellipse([cx - r * k, cy - r * k, cx + r * k, cy + r * k], fill=col)
        else:
            x, y, rx, ry = geom; rx *= fit; ry *= fit
            cx, cy = P(x, y)
            d.ellipse([cx - rx * k, cy - ry * k, cx + rx * k, cy + ry * k], fill=col)


OPS = build()
RAW = extent(OPS)
FIT = min(ART_SCALE, SAFE_R / RAW)
print(f"artwork extent {RAW:.0f} → fit x{FIT:.4f} → {RAW*FIT:.0f} (safe {SAFE_R:.0f})")


def draw_mark(img, full_bleed=False):
    d = ImageDraw.Draw(img)
    k = S / 2000.0
    c = S / 2
    if full_bleed:
        d.rectangle([0, 0, S, S], fill=GOLD)
    else:
        r = S * 0.5
        d.ellipse([c - r, c - r, c + r, c + r], fill=INK)
        r2 = r * (FIELD_R / 1000.0)
        d.ellipse([c - r2, c - r2, c + r2, c + r2], fill=GOLD)
        r3 = r * 0.893
        d.ellipse([c - r3, c - r3, c + r3, c + r3], outline=TERRA, width=max(2, int(S * 0.0055)))
    render_ops(d, OPS, k, FIT)
    return img


def render(full_bleed=False, content=1.0):
    if content == 1.0:
        return draw_mark(Image.new("RGBA", (S, S), (0, 0, 0, 0)), full_bleed)
    out = Image.new("RGBA", (S, S), GOLD)
    inner = draw_mark(Image.new("RGBA", (S, S), (0, 0, 0, 0)), full_bleed=True)
    sm = inner.resize((int(S * content), int(S * content)), Image.LANCZOS)
    off = int((S - S * content) / 2)
    out.alpha_composite(sm, (off, off))
    return out


def save(img, name, size, mode="RGBA"):
    o = img.resize((size, size), Image.LANCZOS)
    if mode == "RGB":
        flat = Image.new("RGB", (size, size), GOLD[:3])
        flat.paste(o, mask=o.split()[3]); o = flat
    p = os.path.join(OUT, name)
    o.save(p)
    print(f"  {name:30} {size:>3}x{size:<3} {os.path.getsize(p):>7,} B")


badge = render(False)
mask = render(True, content=0.72)

print("writing icons:")
save(badge, "icon-192.png", 192)
save(badge, "icon-512.png", 512)
save(mask, "icon-maskable-512.png", 512)
save(badge, "apple-touch-icon-180.png", 180, mode="RGB")
flat_ico = render(True, content=0.88)
flat_rgb = Image.new("RGB", (S, S), GOLD[:3])
flat_rgb.paste(flat_ico, mask=flat_ico.split()[3])
flat_rgb.resize((48, 48), Image.LANCZOS).save(
    os.path.join(OUT, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
print(f"  {'favicon.ico':30}  16/32/48 {os.path.getsize(os.path.join(OUT,'favicon.ico')):>7,} B")

sheet = Image.new("RGB", (700, 320), (250, 250, 246))
x = 22
for s in (192, 96, 64, 48, 32, 16):
    t = badge.resize((s, s), Image.LANCZOS); sheet.paste(t, (x, 24), t); x += s + 16
m = mask.resize((150, 150), Image.LANCZOS); sheet.paste(m, (22, 150))
a = badge.resize((150, 150), Image.LANCZOS); sheet.paste(a, (196, 150), a)
sheet.save(os.path.join(OUT, "_preview.png"))
print("  _preview.png (contact sheet)")
