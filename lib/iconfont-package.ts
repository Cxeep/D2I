export type IconLibraryItem = {
  id: string
  name: string
  paths: string[]
}

export type IconfontJson = {
  css_prefix_text?: string
  glyphs?: Array<{
    name?: string
    font_class?: string
  }>
}

export function parseSymbolPathsFromIconfontJs(js: string): Map<string, string[]> {
  const m = js.match(/<svg[\s\S]*<\/svg>/)
  const svgText = m ? m[0] : ''
  const map = new Map<string, string[]>()
  if (!svgText) return map

  const symbolRe = /<symbol\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g
  let sm: RegExpExecArray | null
  while ((sm = symbolRe.exec(svgText))) {
    const symbolId = sm[1]
    const body = sm[2]
    const paths: string[] = []
    const pathRe = /<path\b[^>]*\bd="([^"]+)"[^>]*>/g
    let pm: RegExpExecArray | null
    while ((pm = pathRe.exec(body))) paths.push(pm[1])
    if (paths.length > 0) map.set(symbolId, paths)
  }
  return map
}

export function buildIconLibraryFromIconfontPackage(args: {
  iconfontJsRaw: string
  iconfontJson: IconfontJson
}): IconLibraryItem[] {
  const symbolMap = parseSymbolPathsFromIconfontJs(args.iconfontJsRaw)
  const prefix = args.iconfontJson?.css_prefix_text ?? 'icon-'
  const glyphs = args.iconfontJson?.glyphs ?? []

  const out: IconLibraryItem[] = []
  for (const g of glyphs) {
    const fontClass = String(g.font_class ?? '').trim()
    if (!fontClass) continue
    const symbolId = `${prefix}${fontClass}`
    const paths = symbolMap.get(symbolId) ?? []
    out.push({
      id: fontClass,
      name: String(g.name ?? fontClass),
      paths,
    })
  }
  return out
}

