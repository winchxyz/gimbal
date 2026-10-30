"""Build the Gimbal wordmark and symbol as outlined SVG.

Letters are Inter Tight Medium (SIL OFL 1.1), outlined so no font ships with the mark.
The only drawn element is the tittle of the i: a flat bar instead of a dot, the level line.
Run: python build_wordmark.py <path to InterTight-Medium.ttf>
"""
import sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

font = TTFont(sys.argv[1])
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
ASC = 1490          # top of b and l
TRACK = -34         # tighter than text setting; the mark is read at display size
KERN = {('g', 'i'): 6, ('i', 'm'): 6, ('b', 'a'): -10, ('a', 'l'): 4}
STEM_X = (76 + 350) / 2   # centre of the i stem in its own glyph space
BAR_W, BAR_H = 560, 150   # the level: wider than the stem, thinner than it


def outline(text):
    x, parts, bar = 0, [], None
    prev = None
    for ch in text:
        name = 'dotlessi' if ch == 'i' else cmap[ord(ch)]
        if prev:
            x += KERN.get((prev, ch), 0)
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, ASC)))
        parts.append(pen.getCommands())
        if ch == 'i':
            cx = x + STEM_X
            bar = (cx - BAR_W / 2, 0, BAR_W, BAR_H)   # top of the bar sits on the ascender line
        x += glyphs[name].width + TRACK
        prev = ch
    return ' '.join(parts), bar, x - TRACK


word, bar, width = outline('gimbal')
DESC = 442
H = ASC + DESC
out = Path(__file__).parent
bar_rect = f'<rect class="level" x="{bar[0]:.0f}" y="{bar[1]:.0f}" width="{bar[2]}" height="{bar[3]}"/>'
(out / 'wordmark.svg').write_text(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.0f} {H}" fill="currentColor">'
    f'<path d="{word}"/>{bar_rect}</svg>\n')

# symbol: the i alone, stem plus level, on a square
pen = SVGPathPen(glyphs)
stem_bounds = BoundsPen(glyphs)
glyphs['dotlessi'].draw(stem_bounds)
x0, y0, x1, y1 = stem_bounds.bounds
size = 2400
ox = size / 2 - (x0 + x1) / 2
top = (size - ASC) / 2              # stem plus bar, centred as one shape
glyphs['dotlessi'].draw(TransformPen(pen, (1, 0, 0, -1, ox, top + ASC)))
bar_y = top
(out / 'symbol.svg').write_text(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" fill="currentColor">'
    f'<path d="{pen.getCommands()}"/><rect class="level" x="{size / 2 - BAR_W / 2:.0f}" y="{bar_y:.0f}" width="{BAR_W}" height="{BAR_H}"/></svg>\n')
print('wordmark', round(width), 'x', H)
