export type FilterableNode = {
  type?: string
  width?: number
  height?: number
  fills?: any
  strokes?: any
  opacity?: number
}

export const FILTER_CONFIG = {
  // 尺寸下限：过滤超小噪声
  minSidePx: 8,
  // 宽高比范围：过滤过扁/过长的元素
  minAspect: 0.2,
  maxAspect: 5,
  // 复杂度上限：按 path 指令数量近似
  maxPathCommands: 520,
}

export function isShapeLikeNode(node: FilterableNode): boolean {
  return ['PEN', 'BOOLEAN_OPERATION', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE'].includes(
    String(node?.type ?? '')
  )
}

export function passSizeAndAspectFilter(
  node: FilterableNode,
  cfg = FILTER_CONFIG
): boolean {
  const w = typeof node.width === 'number' ? node.width : 0
  const h = typeof node.height === 'number' ? node.height : 0
  if (!(w > 0 && h > 0)) return false

  const minSide = Math.min(w, h)
  if (minSide < cfg.minSidePx) return false

  const aspect = w / h
  if (!Number.isFinite(aspect)) return false
  if (aspect < cfg.minAspect || aspect > cfg.maxAspect) return false

  return true
}

export function estimatePathComplexity(pathData: string): number {
  // 以 SVG path 命令数量近似复杂度
  const commands = pathData.match(/[MLCQAZHVST]/gi)
  return commands ? commands.length : 0
}

export function passComplexityFilter(
  paths: string[],
  cfg = FILTER_CONFIG
): boolean {
  if (!Array.isArray(paths) || paths.length === 0) return false
  const total = paths.reduce((sum, d) => sum + estimatePathComplexity(d), 0)
  return total > 0 && total <= cfg.maxPathCommands
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

function paintAlpha(paint: any): number {
  if (!paint || typeof paint !== 'object') return 0
  if (paint.isVisible === false) return 0
  const type = String(paint.type ?? '')
  if (!type) return 0
  const a = typeof paint.alpha === 'number' ? paint.alpha : 1
  if (type === 'SOLID') {
    const ca = typeof paint.color?.alpha === 'number' ? paint.color.alpha : 1
    return clamp01(a * ca)
  }
  if (type.startsWith('GRADIENT_') || type === 'IMAGE') {
    return clamp01(a)
  }
  return 0
}

function hasVisiblePaint(paints: any): boolean {
  if (!Array.isArray(paints) || paints.length === 0) return false
  for (const p of paints) {
    if (paintAlpha(p) > 0) return true
  }
  return false
}

/**
 * 过滤掉“无色透明”节点：fills/strokes 都不可见（或 alpha=0）。
 *
 * - `SOLID` 使用 `paint.color.alpha`（官方 typings 说明纯色 alpha 在 color.alpha）
 * - 其他 paint 使用 `paint.alpha`（如 GRADIENT/IMAGE）
 * - `paint.isVisible === false` 视为不可见
 * - 节点自身 `opacity` 为 0 也视为不可见
 */
export function passVisiblePaintFilter(node: FilterableNode): boolean {
  const nodeOpacity = typeof (node as any).opacity === 'number' ? (node as any).opacity : 1
  if (clamp01(nodeOpacity) <= 0) return false
  return hasVisiblePaint((node as any).fills) || hasVisiblePaint((node as any).strokes)
}

