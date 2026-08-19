"""
Generates public/icons/badge-96.png — the Android notification badge.

Why this is drawn rather than derived from the app icon:

Android renders a notification's `badge` as a SILHOUETTE. It throws the colour
away and paints every opaque pixel white, at roughly 24dp in the status bar. So
the badge's only meaningful content is its alpha channel, and passing a normal
app icon — which is opaque corner to corner — produces a solid white square.
That is exactly what shipped first and what a member reported.

Deriving a silhouette from the real artwork was tried twice and abandoned: a
"differs from the background" mask includes the cloud bank and reduces to a
lumpy blob, and an ink-threshold mask inverts the horns into holes. Both are
mush by 24px. The detail that makes the app icon good is precisely what cannot
survive here, so the badge is a purpose-drawn glyph instead: head and horns
only, bold enough to read at 18px.

Run:  python tools/make-badge.py
"""
import math
import os
from PIL import Image, ImageDraw

OUT = os.path.join('public', 'icons', 'badge-96.png')
N = 2048          # drawn large, downsampled with LANCZOS
C = 1000.0        # design space is 2000x2000, centre (1000,1000)
K = N / 2000.0


def bez(p0, p1, p2, n=140):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
    return out


def taper(centre, w0, w1):
    """Offset a centreline into a closed tapered shape — thick at the skull, a
    point at the tip. Guessing two edge curves instead makes horns read as
    wings; this was learned the hard way on the first icon attempt."""
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
    return a + b[::-1]


mirror = lambda pts: [(2 * C - x, y) for x, y in pts]
scale = lambda pts: [(x * K, y * K) for x, y in pts]

mask = Image.new('L', (N, N), 0)
d = ImageDraw.Draw(mask)

# Ram horns, not bull horns: out over the top of the skull, then curling DOWN
# and back in, the tip finishing low near the jaw. Two chained curves rather than
# one — a single quadratic cannot reverse direction, and a horn that only sweeps
# up reads as a longhorn, which is not the animal in the artwork.
for side in (1, -1):
    centre = (bez((872, 868), (628, 672), (360, 880), 70)      # out and over the crown
              + bez((360, 880), (206, 1150), (486, 1286), 70))  # curling down and in
    horn = taper(centre, 170, 12)
    d.polygon(scale(horn if side == 1 else mirror(horn)), fill=255)

head = (bez((788, 880), (1000, 700), (1212, 880))
        + bez((1212, 880), (1306, 1030), (1252, 1186))
        + bez((1252, 1186), (1214, 1290), (1136, 1330))
        + bez((1136, 1330), (1188, 1436), (1124, 1520))
        + bez((1124, 1520), (1000, 1604), (876, 1520))
        + bez((876, 1520), (812, 1436), (864, 1330))
        + bez((864, 1330), (786, 1290), (748, 1186))
        + bez((748, 1186), (694, 1030), (788, 880)))
d.polygon(scale(head), fill=255)

for (x, y, r) in [(898, 798, 58), (1000, 772, 64), (1102, 798, 58)]:
    d.ellipse([(x - r) * K, (y - r) * K, (x + r) * K, (y + r) * K], fill=255)

# Trim to the glyph, square it, leave a little room — Android insets it further.
mask = mask.crop(mask.getbbox())
side_px = int(max(mask.size) * 1.08)
square = Image.new('L', (side_px, side_px), 0)
square.paste(mask, ((side_px - mask.size[0]) // 2, (side_px - mask.size[1]) // 2))

# Solid white, with the shape carried entirely by alpha. The RGB is irrelevant
# to Android but keeping it white means the file also looks right anywhere that
# does honour colour.
white = Image.new('L', (side_px, side_px), 255)
badge = Image.merge('RGBA', (white, white, white, square))
badge.resize((96, 96), Image.LANCZOS).save(OUT)

check = Image.open(OUT)
alpha = check.split()[3]
lo, hi = alpha.getextrema()
print(f'{OUT}  {check.size}  {check.mode}  {os.path.getsize(OUT):,} B')
print(f'  alpha range {lo}-{hi}  (must include 0, or Android paints a filled square)')
assert check.mode == 'RGBA' and lo == 0, 'badge must be transparent outside the glyph'
print('  OK')
