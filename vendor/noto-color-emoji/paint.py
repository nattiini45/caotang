"""Flattens a COLRv1 paint graph into PDF content-stream operators, for build.py.

The run time never reads a font. It reads what this file writes: for each emoji, one string of operators that draws it in a
Type 3 glyph (`d0`, coloured), and the shapes, shadings, graphics states and soft masks that string names. Everything here is
offline.

A glyph is one flat sequence in the font's own units (the first operator scales them to the 1000-unit em of the Type 3 font).
A layer filled with a solid colour is `r g b rg` and its outline; an outline that several emoji use (the figure of 👍 under
each of its five skin tones) is a Form XObject all of them draw (`Do`) and the pool keeps once, and the transform above a layer
is one `cm` around it. A layer filled with a gradient is clipped to its outline (`W n`) and painted with a shading (`sh`) that
keeps the coordinates it has in the font, so two emoji with the same gradient share one shading. A gradient whose stops differ
in opacity is a shading of its colours drawn through a soft mask that is a gray shading of its opacities. PaintComposite is read
for the two modes the font uses: SRC_IN (the source is clipped to the shape of the backdrop, which is not drawn) and SOFT_LIGHT
(the source is drawn with the SoftLight blend mode). Anything else, and every paint that is not in the font, stops the build.

Outlines are TrueType (quadratic). PDF has cubic curves only, so a quadratic becomes the cubic that draws it exactly, and a pair
of quadratics that the font cut from one cubic becomes that cubic again when it draws the pair within TOLERANCE font units.
"""

import math
from collections import defaultdict

from fontTools.pens.basePen import BasePen
from fontTools.ttLib.tables import otTables

IDENTITY = (1, 0, 0, 1, 0, 0)
Matrix = tuple  # (a, b, c, d, e, f): x' = a*x + c*y + e, y' = b*x + d*y + f
# A rectangle that covers every glyph, for a fill that only the clip bounds.
EVERYWHERE = "-8000 -8000 16000 16000 re"
# The most a merged pair of quadratics may stray from the two curves it replaces, in font units (1/1024 em).
TOLERANCE = 0.8


def compose(outer: Matrix, inner: Matrix) -> Matrix:
    """The transform that applies `inner` first, then `outer`."""
    a1, b1, c1, d1, e1, f1 = outer
    a2, b2, c2, d2, e2, f2 = inner
    return (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    )


def apply(m: Matrix, x: float, y: float) -> tuple:
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


def num(value: float, places: int = 3) -> str:
    """A number as short as it can be written to `places` decimals: `12`, `-0.5`, never `-0` or `1.0`."""
    text = f"{value:.{places}f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def quad_point(p0, q, p1, t):
    u = 1 - t
    return (u * u * p0[0] + 2 * u * t * q[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * q[1] + t * t * p1[1])


def cubic_point(p0, a, b, p1, t):
    u = 1 - t
    return tuple(u ** 3 * p0[i] + 3 * u * u * t * a[i] + 3 * u * t * t * b[i] + t ** 3 * p1[i] for i in range(2))


def quad_to_cubic(p0, q, p1):
    a = (p0[0] + 2 / 3 * (q[0] - p0[0]), p0[1] + 2 / 3 * (q[1] - p0[1]))
    b = (p1[0] + 2 / 3 * (q[0] - p1[0]), p1[1] + 2 / 3 * (q[1] - p1[1]))
    return (round(a[0]), round(a[1])), (round(b[0]), round(b[1])), p1


def merged(p0, q1, p1, q2, p2):
    """The cubic from p0 to p2 that draws the quadratics p0-q1-p1 and p1-q2-p2 within TOLERANCE, or None."""
    for k in (4 / 3, 1.28, 1.38):
        a = (round(p0[0] + k * (q1[0] - p0[0])), round(p0[1] + k * (q1[1] - p0[1])))
        b = (round(p2[0] + k * (q2[0] - p2[0])), round(p2[1] + k * (q2[1] - p2[1])))
        samples = [cubic_point(p0, a, b, p2, i / 48) for i in range(49)]
        fits = True
        for p_a, q, p_b in ((p0, q1, p1), (p1, q2, p2)):
            for i in range(0, 13):
                point = quad_point(p_a, q, p_b, i / 12)
                if min(math.dist(point, s) for s in samples) > TOLERANCE:
                    fits = False
                    break
            if not fits:
                break
        if fits:
            return (a, b, p2)
    return None


class Contours(BasePen):
    """A glyph's outline as contours of lines and quadratic segments, in font units."""

    def __init__(self, glyph_set):
        super().__init__(glyph_set)
        self.contours = []
        self.current = None

    def _moveTo(self, p):
        self.current = (p, [])
        self.contours.append(self.current)

    def _lineTo(self, p):
        self.current[1].append(("l", p))

    def _qCurveToOne(self, q, p):
        self.current[1].append(("q", q, p))

    def _curveToOne(self, a, b, p):
        self.current[1].append(("c", a, b, p))

    def _closePath(self):
        pass

    def _endPath(self):
        pass


class Outline:
    """A glyph's outline as PDF path operators: lines and cubics, with pairs of quadratics merged back into the cubics they came from."""

    def __init__(self, glyph_set, name: str):
        pen = Contours(glyph_set)
        glyph_set[name].draw(pen)
        self.contours = []
        for start, segments in pen.contours:
            start = (round(start[0]), round(start[1]))
            out = []
            at = start
            i = 0
            while i < len(segments):
                kind = segments[i][0]
                if kind == "q":
                    q1, p1 = segments[i][1], segments[i][2]
                    if i + 1 < len(segments) and segments[i + 1][0] == "q":
                        fit = merged(at, q1, p1, segments[i + 1][1], segments[i + 1][2])
                        if fit is not None:
                            out.append(("c", *fit))
                            at = fit[2]
                            i += 2
                            continue
                    cubic = quad_to_cubic(at, q1, (round(p1[0]), round(p1[1])))
                    out.append(("c", *cubic))
                    at = cubic[2]
                elif kind == "l":
                    at = (round(segments[i][1][0]), round(segments[i][1][1]))
                    out.append(("l", at))
                else:
                    cubic = tuple((round(p[0]), round(p[1])) for p in segments[i][1:])
                    out.append(("c", *cubic))
                    at = cubic[2]
                i += 1
            self.contours.append((start, out))

    def text(self, matrix: Matrix) -> tuple:
        """The path operators with a transform applied, and the points they use. A transform other than the identity rounds to a tenth."""
        identity = matrix == IDENTITY
        points = []

        def at(p):
            x, y = (p[0], p[1]) if identity else apply(matrix, p[0], p[1])
            points.append((x, y))
            return f"{x} {y}" if identity else f"{num(x, 1)} {num(y, 1)}"

        parts = []
        for start, segments in self.contours:
            parts.append(f"{at(start)} m")
            for segment in segments:
                if segment[0] == "l":
                    parts.append(f"{at(segment[1])} l")
                else:
                    parts.append(f"{at(segment[1])} {at(segment[2])} {at(segment[3])} c")
            parts.append("h")
        return " ".join(parts), points

    def bounds(self) -> tuple:
        points = [start for start, _ in self.contours]
        for _, segments in self.contours:
            for segment in segments:
                points.extend(segment[1:])
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        return min(xs), min(ys), max(xs), max(ys)


class Pool:
    """The shapes, shadings, graphics states and soft masks glyphs share, each written once. An id is a kind letter and the entry's number."""

    def __init__(self):
        self.entries = []
        self.index = {}

    def add(self, kind: str, text: str) -> str:
        key = kind + text
        if key not in self.index:
            self.index[key] = len(self.entries)
            self.entries.append(key)
        return f"{kind}{self.index[key]}"


class Compiler:
    """Compiles base glyphs. `shared` is the set of layer glyphs drawn as Form XObjects; the `uses` of a first pass choose it."""

    def __init__(self, font, pool: Pool, shared=frozenset(), outlines=None):
        self.font = font
        self.pool = pool
        self.shared = shared
        self.glyphs = font.getGlyphSet()
        self.colr = font["COLR"].table
        self.palette = font["CPAL"].palettes[0]
        self.layers = self.colr.LayerList.Paint
        self.base = {record.BaseGlyph: record.Paint for record in self.colr.BaseGlyphList.BaseGlyphPaintRecord}
        scale = 1000 / font["head"].unitsPerEm
        self.scale = scale
        self.root = (scale, 0, 0, scale, 0, 0)
        self.outlines = {} if outlines is None else outlines
        # The layer glyphs each base glyph fills with a solid colour, from the first pass.
        self.uses = defaultdict(set)
        # What a SRC_IN over a solid backdrop leaves of its source: the backdrop's opacity, applied to every colour inside.
        self.opacity = 1.0
        self.base_name = ""

    # -- colours ---------------------------------------------------------

    def colour(self, index: int, alpha: float) -> tuple:
        c = self.palette[index]
        return (c.red / 255, c.green / 255, c.blue / 255, alpha * c.alpha / 255 * self.opacity)

    @staticmethod
    def rgb(colour: tuple) -> str:
        r, g, b = colour[0], colour[1], colour[2]
        if r == g == b:
            return f"{num(r)} g"
        return f"{num(r)} {num(g)} {num(b)} rg"

    # -- the walk --------------------------------------------------------

    def outline(self, name: str) -> Outline:
        if name not in self.outlines:
            self.outlines[name] = Outline(self.glyphs, name)
        return self.outlines[name]

    def compile(self, name: str) -> tuple:
        """The operators of a base glyph, the pool ids they use and the glyph's bounding box in the 1000-unit em."""
        self.base_name = name
        state = {"ops": [f"{num(self.scale, 7)} 0 0 {num(self.scale, 7)} 0 0 cm"], "ids": [], "points": [], "fill": None}
        self.paint(self.base[name], IDENTITY, None, state)
        points = [apply(self.root, x, y) for x, y in state["points"]]
        if not points:
            raise SystemExit(f"{name} draws nothing")
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        bbox = (math.floor(min(xs)), math.floor(min(ys)), math.ceil(max(xs)), math.ceil(max(ys)))
        return " ".join(state["ops"]), sorted(set(state["ids"])), bbox

    def use(self, state: dict, ident: str) -> str:
        state["ids"].append(ident)
        return ident

    def shape_of(self, paint, matrix: Matrix, state: dict) -> str:
        """The shapes a paint (the backdrop of a SRC_IN) draws, as one path for a clip. A shape inside the box of another is left out."""
        found = []
        stack = [(paint, matrix)]
        while stack:
            node, m = stack.pop()
            kind = node.Format
            if kind == otTables.PaintFormat.PaintGlyph:
                text, points = self.outline(node.Glyph).text(m)
                xs = [p[0] for p in points]
                ys = [p[1] for p in points]
                found.append((min(xs), min(ys), max(xs), max(ys), text, points))
            elif kind == otTables.PaintFormat.PaintColrLayers:
                for i in range(node.FirstLayerIndex, node.FirstLayerIndex + node.NumLayers):
                    stack.append((self.layers[i], m))
            elif kind == otTables.PaintFormat.PaintComposite:
                # A solid backdrop has no shape, so the source's is the shape; any other source is clipped to its backdrop.
                solid = node.BackdropPaint.Format == otTables.PaintFormat.PaintSolid
                stack.append((node.SourcePaint if solid else node.BackdropPaint, m))
            else:
                transform = self.transform_of(node)
                if transform is None:
                    raise SystemExit(f"a SRC_IN backdrop holds paint format {kind}, which has no shape")
                stack.append((node.Paint, compose(m, transform)))
        kept = [
            s for i, s in enumerate(found)
            if not any(j != i and o[0] <= s[0] and o[1] <= s[1] and o[2] >= s[2] and o[3] >= s[3] and (o[:4] != s[:4] or j < i) for j, o in enumerate(found))
        ]
        for s in kept:
            state["points"].extend(s[5])
        return " ".join(s[4] for s in kept)

    def transform_of(self, node):
        f = otTables.PaintFormat
        kind = node.Format
        if kind == f.PaintTransform:
            t = node.Transform
            return (t.xx, t.yx, t.xy, t.yy, t.dx, t.dy)
        if kind == f.PaintTranslate:
            return (1, 0, 0, 1, node.dx, node.dy)
        if kind == f.PaintScale:
            return (node.scaleX, 0, 0, node.scaleY, 0, 0)
        if kind == f.PaintScaleAroundCenter:
            sx, sy, cx, cy = node.scaleX, node.scaleY, node.centerX, node.centerY
            return (sx, 0, 0, sy, cx - sx * cx, cy - sy * cy)
        return None

    def paint(self, node, matrix: Matrix, blend, state: dict) -> None:
        f = otTables.PaintFormat
        kind = node.Format
        if kind == f.PaintColrLayers:
            for i in range(node.FirstLayerIndex, node.FirstLayerIndex + node.NumLayers):
                self.paint(self.layers[i], matrix, blend, state)
        elif kind == f.PaintGlyph:
            self.fill(node, matrix, blend, state)
        elif kind == f.PaintComposite:
            self.composite(node, matrix, blend, state)
        elif kind == f.PaintSolid:
            self.solid(None, self.colour(node.PaletteIndex, node.Alpha), IDENTITY, blend, state)
        elif kind in (f.PaintLinearGradient, f.PaintRadialGradient):
            self.gradient(None, node, matrix, blend, state)
        else:
            transform = self.transform_of(node)
            if transform is None:
                raise SystemExit(f"paint format {kind} is not in the font this build was written for")
            self.paint(node.Paint, compose(matrix, transform), blend, state)

    def composite(self, node, matrix: Matrix, blend, state: dict) -> None:
        mode = node.CompositeMode
        modes = otTables.CompositeMode
        if mode == modes.SOFT_LIGHT:
            self.paint(node.BackdropPaint, matrix, blend, state)
            self.paint(node.SourcePaint, matrix, "SoftLight", state)
        elif mode == modes.SRC_IN and node.BackdropPaint.Format == otTables.PaintFormat.PaintSolid:
            # A solid backdrop has no shape: it only lets its opacity through.
            kept = self.opacity
            # colour() carries the opacity already in force, so this nests.
            self.opacity = self.colour(node.BackdropPaint.PaletteIndex, node.BackdropPaint.Alpha)[3]
            self.paint(node.SourcePaint, matrix, blend, state)
            self.opacity = kept
        elif mode == modes.SRC_IN:
            clip = self.shape_of(node.BackdropPaint, matrix, state)
            state["ops"].extend(["q", clip, "W n"])
            state["fill"] = None
            self.paint(node.SourcePaint, matrix, blend, state)
            state["ops"].append("Q")
            state["fill"] = None
        else:
            raise SystemExit(f"composite mode {mode} is not in the font this build was written for")

    # -- fills -----------------------------------------------------------

    def fill(self, node, matrix: Matrix, blend, state: dict) -> None:
        f = otTables.PaintFormat
        child = node.Paint
        if child.Format == f.PaintSolid:
            self.solid(node.Glyph, self.colour(child.PaletteIndex, child.Alpha), matrix, blend, state)
        elif child.Format in (f.PaintLinearGradient, f.PaintRadialGradient):
            self.gradient(node.Glyph, child, matrix, blend, state)
        else:
            # Paint under a glyph that is not a fill: the glyph's outline clips what it draws.
            text, points = self.outline(node.Glyph).text(matrix)
            state["points"].extend(points)
            state["ops"].extend(["q", text, "W n"])
            state["fill"] = None
            self.paint(child, matrix, blend, state)
            state["ops"].append("Q")
            state["fill"] = None

    def gs(self, state: dict, alpha: float, blend) -> str:
        parts = []
        if blend is not None:
            parts.append(f"/BM /{blend}")
        parts.append(f"/ca {num(alpha, 2)}")
        return self.use(state, self.pool.add("g", f"<< {' '.join(parts)} >>"))

    def solid(self, glyph, colour: tuple, matrix: Matrix, blend, state: dict) -> None:
        """Fills a layer glyph (or, with none, everything the clip leaves) with a solid colour."""
        ops = state["ops"]
        alpha = round(colour[3], 2)
        if alpha <= 0:
            return
        translucent = alpha < 1 or blend is not None
        paint = self.rgb(colour)
        if glyph is None:
            body = [EVERYWHERE, "f"]
        else:
            outline = self.outline(glyph)
            self.uses[glyph].add(self.base_name)
            if glyph in self.shared:
                form = self.use(state, self.pool.add("p", outline.text(IDENTITY)[0] + " f"))
                transform = [] if matrix == IDENTITY else ["q", " ".join(num(v, 4) for v in matrix) + " cm"]
                body = [*transform, f"/{form} Do", *([] if matrix == IDENTITY else ["Q"])]
                state["points"].extend(apply(matrix, *corner) for corner in _corners(outline.bounds()))
            else:
                text, points = outline.text(matrix)
                state["points"].extend(points)
                body = [text, "f"]
        if translucent:
            ops.extend(["q", f"/{self.gs(state, alpha, blend)} gs", paint, *body, "Q"])
            state["fill"] = None
        else:
            if state["fill"] != paint:
                ops.append(paint)
                state["fill"] = paint
            ops.extend(body)

    # -- gradients -------------------------------------------------------

    def stops(self, line) -> list:
        stops = sorted(((s.StopOffset, self.colour(s.PaletteIndex, s.Alpha)) for s in line.ColorStop), key=lambda s: s[0])
        if stops[0][0] > 0:
            stops.insert(0, (0.0, stops[0][1]))
        if stops[-1][0] < 1:
            stops.append((1.0, stops[-1][1]))
        if stops[0][0] < 0 or stops[-1][0] > 1:
            raise SystemExit("a colour line reaches past 0 or 1, which this build does not write")
        return stops

    def function(self, stops: list, values) -> str:
        """The PDF function of a colour line: one exponential segment per pair of stops, stitched. `values` picks a stop's output."""
        outputs = [values(colour) for _, colour in stops]
        segments = []
        for a, b in zip(outputs, outputs[1:]):
            segments.append(f"<< /FunctionType 2 /Domain [0 1] /C0 [{' '.join(a)}] /C1 [{' '.join(b)}] /N 1 >>")
        if len(segments) == 1:
            return segments[0]
        bounds = []
        for offset in [s[0] for s in stops][1:-1]:
            bounds.append(max(offset, (float(bounds[-1]) + 0.0001) if bounds else 0.0))
            bounds[-1] = num(bounds[-1], 4)
        encode = " ".join("0 1" for _ in segments)
        return f"<< /FunctionType 3 /Domain [0 1] /Functions [{' '.join(segments)}] /Bounds [{' '.join(bounds)}] /Encode [{encode}] >>"

    def geometry(self, paint):
        """The shading's type and coordinates, in the font's units, before any transform."""
        if paint.Format == otTables.PaintFormat.PaintLinearGradient:
            p0 = (paint.x0, paint.y0)
            d01 = (paint.x1 - paint.x0, paint.y1 - paint.y0)
            d02 = (paint.x2 - paint.x0, paint.y2 - paint.y0)
            # The colour line runs along p0p1 projected on the perpendicular of p0p2.
            normal = (-d02[1], d02[0])
            length = normal[0] ** 2 + normal[1] ** 2
            if length == 0:
                return None
            k = (d01[0] * normal[0] + d01[1] * normal[1]) / length
            p3 = (p0[0] + normal[0] * k, p0[1] + normal[1] * k)
            if p3 == p0:
                return None
            return 2, f"[{num(p0[0], 2)} {num(p0[1], 2)} {num(p3[0], 2)} {num(p3[1], 2)}]"
        return 3, f"[{num(paint.x0, 2)} {num(paint.y0, 2)} {num(paint.r0, 2)} {num(paint.x1, 2)} {num(paint.y1, 2)} {num(paint.r1, 2)}]"

    def shading(self, kind: int, coords: str, function: str, space: str) -> str:
        return f"<< /ShadingType {kind} /ColorSpace /{space} /Coords {coords} /Domain [0 1] /Function {function} /Extend [true true] >>"

    def gradient(self, glyph, paint, matrix: Matrix, blend, state: dict) -> None:
        ops = state["ops"]
        stops = self.stops(paint.ColorLine)
        geometry = self.geometry(paint)
        if geometry is None:
            # A degenerate gradient paints its last colour.
            self.solid(glyph, stops[-1][1], matrix, blend, state)
            return
        kind, coords = geometry
        alphas = {round(colour[3], 2) for _, colour in stops}
        if alphas == {0.0}:
            return
        colours = {(round(c[0], 3), round(c[1], 3), round(c[2], 3)) for _, c in stops}
        ops.append("q")
        if matrix != IDENTITY:
            ops.append(" ".join(num(v, 4) for v in matrix) + " cm")
        if glyph is not None:
            # The clip is the glyph's outline, in the units the transform above is applied to.
            outline = self.outline(glyph)
            ops.extend([outline.text(IDENTITY)[0], "W n"])
            state["points"].extend(apply(matrix, *corner) for corner in _corners(outline.bounds()))
        if len(alphas) == 1:
            alpha = next(iter(alphas))
            if alpha < 1 or blend is not None:
                ops.append(f"/{self.gs(state, alpha, blend)} gs")
        else:
            gray = self.function(stops, lambda c: [num(c[3], 3)])
            extras = f"/BM /{blend} " if blend is not None else ""
            mask = self.pool.add("m", f"{extras}|{self.shading(kind, coords, gray, 'DeviceGray')}")
            ops.append(f"/{self.use(state, mask)} gs")
        if len(colours) == 1:
            # One colour at every stop: it is the fill, and only the opacity varies.
            ops.extend([self.rgb(next(iter(colours))), EVERYWHERE, "f"])
        else:
            function = self.function(stops, lambda c: [num(c[0]), num(c[1]), num(c[2])])
            ops.append(f"/{self.use(state, self.pool.add('s', self.shading(kind, coords, function, 'DeviceRGB')))} sh")
        ops.append("Q")
        state["fill"] = None


def _corners(box: tuple) -> list:
    x0, y0, x1, y1 = box
    return [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]
