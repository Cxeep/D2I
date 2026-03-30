const fs = require('fs')
const path = require('path')

// ---- Geometry descriptor (Node-only, no DOM) ----
function l2Normalize(vec) {
  const n = Math.hypot(...vec) || 1
  return vec.map((v) => v / n)
}

function meanVector(vectors) {
  if (!vectors.length) return []
  const dim = vectors[0].length
  const out = Array.from({ length: dim }, () => 0)
  let count = 0
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== dim) continue
    for (let i = 0; i < dim; i++) out[i] += v[i]
    count++
  }
  if (!count) return []
  for (let i = 0; i < dim; i++) out[i] /= count
  return l2Normalize(out)
}

function fourierMagnitudeDescriptor(sig, opts) {
  const N = sig.length
  if (!N) return []
  const demean = (opts && opts.demean) ?? true
  const l2Norm = (opts && opts.l2Normalize) ?? true
  const maxKeep = Math.max(0, Math.floor(N / 2) - 1)
  const keep = Math.min((opts && opts.keep) ?? Math.min(16, maxKeep), maxKeep)

  let x = sig
  if (demean) {
    const mean = sig.reduce((a, b) => a + b, 0) / N
    x = sig.map((v) => v - mean)
  }

  const mags = []
  for (let k = 1; k <= keep; k++) {
    let re = 0
    let im = 0
    for (let n = 0; n < N; n++) {
      const angle = (-2 * Math.PI * k * n) / N
      re += x[n] * Math.cos(angle)
      im += x[n] * Math.sin(angle)
    }
    mags.push(Math.hypot(re, im))
  }
  if (!l2Norm) return mags
  return l2Normalize(mags)
}

function isCommandToken(t) {
  return /^[a-zA-Z]$/.test(t)
}

function tokenizePath(d) {
  // Split into commands and numbers. Supports commas, signs, decimals, exponents.
  const re = /[a-zA-Z]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g
  return String(d).match(re) || []
}

function rotateVec(x, y, rad) {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return { x: x * c - y * s, y: x * s + y * c }
}

function arcToCenterParam(x1, y1, x2, y2, fa, fs, rx, ry, phi) {
  // Based on SVG arc implementation notes:
  // https://www.w3.org/TR/SVG/implnote.html#ArcImplementationNotes
  const sinPhi = Math.sin(phi)
  const cosPhi = Math.cos(phi)

  const dx2 = (x1 - x2) / 2
  const dy2 = (y1 - y2) / 2
  const x1p = cosPhi * dx2 + sinPhi * dy2
  const y1p = -sinPhi * dx2 + cosPhi * dy2

  rx = Math.abs(rx)
  ry = Math.abs(ry)
  if (rx === 0 || ry === 0) return null

  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) {
    const s = Math.sqrt(lam)
    rx *= s
    ry *= s
  }

  const rx2 = rx * rx
  const ry2 = ry * ry
  const x1p2 = x1p * x1p
  const y1p2 = y1p * y1p

  let num = rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2
  let den = rx2 * y1p2 + ry2 * x1p2
  if (den === 0) return null
  num = Math.max(0, num)
  let coef = Math.sqrt(num / den)
  if (fa === fs) coef = -coef

  const cxp = (coef * rx * y1p) / ry
  const cyp = (-coef * ry * x1p) / rx

  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2

  const vMag = (ux, uy) => Math.hypot(ux, uy) || 1
  const vDot = (ux, uy, vx, vy) => ux * vx + uy * vy
  const vCross = (ux, uy, vx, vy) => ux * vy - uy * vx
  const angleBetween = (ux, uy, vx, vy) => {
    const d = vDot(ux, uy, vx, vy) / (vMag(ux, uy) * vMag(vx, vy))
    const clamped = Math.max(-1, Math.min(1, d))
    const sign = vCross(ux, uy, vx, vy) < 0 ? -1 : 1
    return sign * Math.acos(clamped)
  }

  const ux = (x1p - cxp) / rx
  const uy = (y1p - cyp) / ry
  const vx = (-x1p - cxp) / rx
  const vy = (-y1p - cyp) / ry

  let theta1 = angleBetween(1, 0, ux, uy)
  let dtheta = angleBetween(ux, uy, vx, vy)

  if (!fs && dtheta > 0) dtheta -= 2 * Math.PI
  if (fs && dtheta < 0) dtheta += 2 * Math.PI

  return { cx, cy, rx, ry, phi, theta1, dtheta }
}

function pointOnArc(p, t) {
  const { cx, cy, rx, ry, phi, theta1, dtheta } = p
  const theta = theta1 + dtheta * t
  const x = rx * Math.cos(theta)
  const y = ry * Math.sin(theta)
  const r = rotateVec(x, y, phi)
  return { x: cx + r.x, y: cy + r.y }
}

function cubicAt(p0, p1, p2, p3, t) {
  const mt = 1 - t
  const mt2 = mt * mt
  const t2 = t * t
  return mt2 * mt * p0 + 3 * mt2 * t * p1 + 3 * mt * t2 * p2 + t2 * t * p3
}

function quadAt(p0, p1, p2, t) {
  const mt = 1 - t
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2
}

function samplePathPoints(d, samples = 256) {
  const toks = tokenizePath(d)
  if (!toks.length) return []

  // First pass: build segment list with approximate weights so we can allocate samples by length.
  const segments = []
  let i = 0
  let cmd = null
  let x = 0, y = 0
  let x0 = 0, y0 = 0
  let prevCmd = ''
  let x1 = 0, y1 = 0, x2 = 0, y2 = 0 // for smooth curves

  const nextNum = () => Number(toks[i++])

  const addSeg = (seg) => segments.push(seg)

  while (i < toks.length) {
    const t = toks[i]
    if (isCommandToken(t)) {
      cmd = t
      i++
    } else if (!cmd) {
      // invalid path
      break
    }

    const abs = cmd === cmd.toUpperCase()
    const c = cmd.toUpperCase()

    const cur = () => ({ x, y })

    if (c === 'M') {
      const nx = nextNum()
      const ny = nextNum()
      x = abs ? nx : x + nx
      y = abs ? ny : y + ny
      x0 = x; y0 = y
      // Subsequent pairs are treated as implicit "L"
      while (i < toks.length && !isCommandToken(toks[i])) {
        const lx = nextNum()
        const ly = nextNum()
        const xN = abs ? lx : x + lx
        const yN = abs ? ly : y + ly
        addSeg({ type: 'L', p0: { x, y }, p1: { x: xN, y: yN } })
        x = xN; y = yN
      }
    } else if (c === 'Z') {
      addSeg({ type: 'L', p0: { x, y }, p1: { x: x0, y: y0 } })
      x = x0; y = y0
    } else if (c === 'L') {
      while (i < toks.length && !isCommandToken(toks[i])) {
        const nx = nextNum()
        const ny = nextNum()
        const xN = abs ? nx : x + nx
        const yN = abs ? ny : y + ny
        addSeg({ type: 'L', p0: { x, y }, p1: { x: xN, y: yN } })
        x = xN; y = yN
      }
    } else if (c === 'H') {
      while (i < toks.length && !isCommandToken(toks[i])) {
        const nx = nextNum()
        const xN = abs ? nx : x + nx
        addSeg({ type: 'L', p0: { x, y }, p1: { x: xN, y } })
        x = xN
      }
    } else if (c === 'V') {
      while (i < toks.length && !isCommandToken(toks[i])) {
        const ny = nextNum()
        const yN = abs ? ny : y + ny
        addSeg({ type: 'L', p0: { x, y }, p1: { x, y: yN } })
        y = yN
      }
    } else if (c === 'C') {
      while (i < toks.length && !isCommandToken(toks[i])) {
        const a1 = nextNum(), b1 = nextNum(), a2 = nextNum(), b2 = nextNum(), a = nextNum(), b = nextNum()
        const p1 = { x: abs ? a1 : x + a1, y: abs ? b1 : y + b1 }
        const p2 = { x: abs ? a2 : x + a2, y: abs ? b2 : y + b2 }
        const p = { x: abs ? a : x + a, y: abs ? b : y + b }
        addSeg({ type: 'C', p0: { x, y }, p1, p2, p3: p })
        x1 = p2.x; y1 = p2.y
        x2 = p.x; y2 = p.y
        x = p.x; y = p.y
      }
    } else if (c === 'S') {
      while (i < toks.length && !isCommandToken(toks[i])) {
        const a2 = nextNum(), b2 = nextNum(), a = nextNum(), b = nextNum()
        const p2 = { x: abs ? a2 : x + a2, y: abs ? b2 : y + b2 }
        const p = { x: abs ? a : x + a, y: abs ? b : y + b }
        // reflect previous control point if previous was cubic
        let p1
        if (prevCmd === 'C' || prevCmd === 'S') {
          p1 = { x: 2 * x - x1, y: 2 * y - y1 }
        } else {
          p1 = cur()
        }
        addSeg({ type: 'C', p0: { x, y }, p1, p2, p3: p })
        x1 = p2.x; y1 = p2.y
        x2 = p.x; y2 = p.y
        x = p.x; y = p.y
      }
    } else if (c === 'Q') {
      while (i < toks.length && !isCommandToken(toks[i])) {
        const a1 = nextNum(), b1 = nextNum(), a = nextNum(), b = nextNum()
        const p1 = { x: abs ? a1 : x + a1, y: abs ? b1 : y + b1 }
        const p = { x: abs ? a : x + a, y: abs ? b : y + b }
        addSeg({ type: 'Q', p0: { x, y }, p1, p2: p })
        x1 = p1.x; y1 = p1.y
        x2 = p.x; y2 = p.y
        x = p.x; y = p.y
      }
    } else if (c === 'T') {
      while (i < toks.length && !isCommandToken(toks[i])) {
        const a = nextNum(), b = nextNum()
        const p = { x: abs ? a : x + a, y: abs ? b : y + b }
        let p1
        if (prevCmd === 'Q' || prevCmd === 'T') {
          p1 = { x: 2 * x - x1, y: 2 * y - y1 }
        } else {
          p1 = cur()
        }
        addSeg({ type: 'Q', p0: { x, y }, p1, p2: p })
        x1 = p1.x; y1 = p1.y
        x2 = p.x; y2 = p.y
        x = p.x; y = p.y
      }
    } else if (c === 'A') {
      while (i < toks.length && !isCommandToken(toks[i])) {
        const rx = nextNum(), ry = nextNum(), xAxisRotation = nextNum()
        const largeArcFlag = nextNum(), sweepFlag = nextNum()
        const a = nextNum(), b = nextNum()
        const p = { x: abs ? a : x + a, y: abs ? b : y + b }
        const phi = (xAxisRotation * Math.PI) / 180
        const arc = arcToCenterParam(x, y, p.x, p.y, !!largeArcFlag, !!sweepFlag, rx, ry, phi)
        if (arc) addSeg({ type: 'A', p0: { x, y }, p1: p, arc })
        else addSeg({ type: 'L', p0: { x, y }, p1: p })
        x = p.x; y = p.y
      }
    } else {
      // Unsupported command: best-effort skip numbers until next command.
      while (i < toks.length && !isCommandToken(toks[i])) i++
    }

    prevCmd = c
  }

  if (!segments.length) return []

  // Approx length by flattening each seg into small steps.
  const approxSegLen = (seg) => {
    const steps = 12
    let len = 0
    let prev = null
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      let p
      if (seg.type === 'L') {
        p = { x: seg.p0.x + (seg.p1.x - seg.p0.x) * t, y: seg.p0.y + (seg.p1.y - seg.p0.y) * t }
      } else if (seg.type === 'C') {
        p = {
          x: cubicAt(seg.p0.x, seg.p1.x, seg.p2.x, seg.p3.x, t),
          y: cubicAt(seg.p0.y, seg.p1.y, seg.p2.y, seg.p3.y, t),
        }
      } else if (seg.type === 'Q') {
        p = { x: quadAt(seg.p0.x, seg.p1.x, seg.p2.x, t), y: quadAt(seg.p0.y, seg.p1.y, seg.p2.y, t) }
      } else if (seg.type === 'A') {
        p = pointOnArc(seg.arc, t)
      } else {
        p = seg.p0
      }
      if (prev) len += Math.hypot(p.x - prev.x, p.y - prev.y)
      prev = p
    }
    return len || 0
  }

  const segLens = segments.map(approxSegLen)
  const total = segLens.reduce((a, b) => a + b, 0) || 1

  const pts = []
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]
    const segLen = segLens[si]
    const n = Math.max(2, Math.round((samples * segLen) / total))
    for (let k = 0; k < n; k++) {
      const t = n === 1 ? 1 : k / (n - 1)
      let p
      if (seg.type === 'L') {
        p = { x: seg.p0.x + (seg.p1.x - seg.p0.x) * t, y: seg.p0.y + (seg.p1.y - seg.p0.y) * t }
      } else if (seg.type === 'C') {
        p = {
          x: cubicAt(seg.p0.x, seg.p1.x, seg.p2.x, seg.p3.x, t),
          y: cubicAt(seg.p0.y, seg.p1.y, seg.p2.y, seg.p3.y, t),
        }
      } else if (seg.type === 'Q') {
        p = { x: quadAt(seg.p0.x, seg.p1.x, seg.p2.x, t), y: quadAt(seg.p0.y, seg.p1.y, seg.p2.y, t) }
      } else if (seg.type === 'A') {
        p = pointOnArc(seg.arc, t)
      } else {
        p = seg.p0
      }
      pts.push(p)
    }
  }
  return pts
}

function radialSignatureFromPathDataNode(pathData, bins = 64, samples = 256) {
  const pts = samplePathPoints(pathData, samples)
  if (!pts.length) return []
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const sig = Array.from({ length: bins }, () => 0)
  for (const p of pts) {
    const dx = p.x - cx
    const dy = p.y - cy
    const theta = Math.atan2(dy, dx)
    const t01 = (theta + Math.PI) / (2 * Math.PI)
    const b = Math.min(bins - 1, Math.floor(t01 * bins))
    const r = Math.hypot(dx, dy)
    if (r > sig[b]) sig[b] = r
  }
  const maxR = Math.max(...sig) || 1
  return sig.map((v) => v / maxR)
}

function radialFourierMagnitudeFromPathDataNode(pathData, bins = 64, samples = 256, keep = 16) {
  const sig = radialSignatureFromPathDataNode(pathData, bins, samples)
  if (!sig.length) return []
  return fourierMagnitudeDescriptor(sig, { keep, demean: true, l2Normalize: true })
}

function parseSymbolPathsFromIconfontJs(js) {
  const m = js.match(/<svg[\s\S]*<\/svg>/)
  const svgText = m ? m[0] : ''
  const map = new Map()
  if (!svgText) return map

  const symbolRe = /<symbol\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g
  let sm
  while ((sm = symbolRe.exec(svgText))) {
    const symbolId = sm[1]
    const body = sm[2]
    const paths = []
    const pathRe = /<path\b[^>]*\bd="([^"]+)"[^>]*>/g
    let pm
    while ((pm = pathRe.exec(body))) paths.push(pm[1])
    if (paths.length > 0) map.set(symbolId, paths)
  }
  return map
}

function buildIconLibrary(iconfontJsRaw, iconfontJson) {
  const symbolMap = parseSymbolPathsFromIconfontJs(iconfontJsRaw)
  const prefix = (iconfontJson && iconfontJson.css_prefix_text) || 'icon-'
  const glyphs = (iconfontJson && iconfontJson.glyphs) || []

  const out = []
  for (const g of glyphs) {
    const fontClass = String(g.font_class || '').trim()
    if (!fontClass) continue
    const symbolId = `${prefix}${fontClass}`
    const paths = symbolMap.get(symbolId) || []
    out.push({
      id: fontClass,
      name: String(g.name || fontClass),
      paths,
    })
  }
  return out
}

function main() {
  const projectRoot = path.resolve(__dirname, '..')
  const pkgDir = path.resolve(projectRoot, 'lib', 'font_2722740_olisuf6y4z')
  const iconfontJsPath = path.resolve(pkgDir, 'iconfont.js')
  const iconfontJsonPath = path.resolve(pkgDir, 'iconfont.json')

  if (!fs.existsSync(iconfontJsPath) || !fs.existsSync(iconfontJsonPath)) {
    console.error('iconfont package files not found:', { iconfontJsPath, iconfontJsonPath })
    process.exit(1)
  }

  const jsRaw = fs.readFileSync(iconfontJsPath, 'utf8')
  const json = JSON.parse(fs.readFileSync(iconfontJsonPath, 'utf8'))
  const library = buildIconLibrary(jsRaw, json)

  // Pre-compute geometry descriptor at build time, so UI doesn't need to use DOM to compute them.
  // Keep parameters aligned with ui/App.vue (bins=64, samples=256, keep=16).
  for (const icon of library) {
    const paths = Array.isArray(icon.paths) ? icon.paths : []
    if (!paths.length) continue
    const vecs = paths
      .map((d) => radialFourierMagnitudeFromPathDataNode(d, 64, 256, 16))
      .filter((v) => Array.isArray(v) && v.length)
    if (!vecs.length) continue
    icon.descriptor = meanVector(vecs)
  }

  const outPath = path.resolve(projectRoot, 'lib', 'icon-library.generated.json')
  fs.writeFileSync(outPath, JSON.stringify(library, null, 2), 'utf8')

  console.log(`Wrote ${library.length} icons to ${path.relative(projectRoot, outPath)}`)
}

main()

