export type MaskRenderOptions = {
  /** 渲染画布尺寸（像素）。默认 96。 */
  size?: number
  /** 内容留白比例（0~0.45）。默认 0.08。 */
  paddingFrac?: number
}

let _bboxSvg: SVGSVGElement | null = null

function getBBoxSvg(): SVGSVGElement {
  if (_bboxSvg) return _bboxSvg
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.position = 'absolute'
  svg.style.left = '-10000px'
  svg.style.top = '-10000px'
  svg.style.opacity = '0'
  svg.style.pointerEvents = 'none'
  document.body.appendChild(svg)
  _bboxSvg = svg
  return svg
}

function unionBBox(a: DOMRect | null, b: DOMRect): DOMRect {
  if (!a) return b
  const x1 = Math.min(a.x, b.x)
  const y1 = Math.min(a.y, b.y)
  const x2 = Math.max(a.x + a.width, b.x + b.width)
  const y2 = Math.max(a.y + a.height, b.y + b.height)
  return new DOMRect(x1, y1, x2 - x1, y2 - y1)
}

function getPathsBBox(paths: string[]): DOMRect | null {
  const svg = getBBoxSvg()
  let bbox: DOMRect | null = null
  const created: SVGPathElement[] = []
  try {
    for (const d of paths) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      p.setAttribute('d', d)
      svg.appendChild(p)
      created.push(p)
      const b = p.getBBox()
      bbox = unionBBox(bbox, b)
    }
    return bbox
  } catch {
    return bbox
  } finally {
    for (const p of created) p.remove()
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

function renderPathsToMaskCanvas(paths: string[], opts?: MaskRenderOptions): HTMLCanvasElement | null {
  const size = opts?.size ?? 96
  const paddingFrac = clamp(opts?.paddingFrac ?? 0.08, 0, 0.45)
  if (!paths.length) return null

  const bbox = getPathsBBox(paths)
  if (!bbox || !(bbox.width > 0) || !(bbox.height > 0)) return null

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.clearRect(0, 0, size, size)
  ctx.fillStyle = '#000'

  const pad = size * paddingFrac
  const avail = size - 2 * pad
  const scale = avail / Math.max(bbox.width, bbox.height)

  // 目标：bbox 缩放后居中到画布中心
  const cx = bbox.x + bbox.width / 2
  const cy = bbox.y + bbox.height / 2
  const tx = size / 2
  const ty = size / 2

  ctx.save()
  ctx.translate(tx, ty)
  ctx.scale(scale, scale)
  ctx.translate(-cx, -cy)
  for (const d of paths) {
    ctx.fill(new Path2D(d))
  }
  ctx.restore()

  return canvas
}

export function maskDataUrl(paths: string[], opts?: MaskRenderOptions): string | null {
  const c = renderPathsToMaskCanvas(paths, opts)
  if (!c) return null
  return c.toDataURL('image/png')
}

function downsample(canvas: HTMLCanvasElement, w: number, h: number): ImageData | null {
  const small = document.createElement('canvas')
  small.width = w
  small.height = h
  const sctx = small.getContext('2d')
  if (!sctx) return null
  sctx.clearRect(0, 0, w, h)
  sctx.drawImage(canvas, 0, 0, w, h)
  return sctx.getImageData(0, 0, w, h)
}

export function dHashFromMask(paths: string[], opts?: MaskRenderOptions): bigint | null {
  // dHash 经典尺寸：9x8 => 64bit
  const canvas = renderPathsToMaskCanvas(paths, opts)
  if (!canvas) return null
  const img = downsample(canvas, 9, 8)
  if (!img) return null

  let hash = 0n
  let bit = 0n
  const w = 9
  const h = 8
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const idxA = (y * w + x) * 4
      const idxB = (y * w + x + 1) * 4
      const a = img.data[idxA] // R
      const b = img.data[idxB]
      if (a > b) hash |= (1n << bit)
      bit++
    }
  }
  return hash
}

export function hammingDistance64(a: bigint, b: bigint): number {
  let x = a ^ b
  let c = 0
  while (x) {
    x &= (x - 1n)
    c++
  }
  return c
}

export function dHashSimilarity(a: bigint, b: bigint): number {
  // 1 - dist/64
  return 1 - hammingDistance64(a, b) / 64
}

