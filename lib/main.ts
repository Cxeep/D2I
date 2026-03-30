import { UIMessage, PluginMessage, sendMsgToUI } from '@messages/sender'
import {
  isShapeLikeNode,
  passSizeAndAspectFilter,
  passComplexityFilter,
  passVisiblePaintFilter,
} from '@lib/node-filter'

mg.showUI(__html__)

function countBooleanDescendants(node: any): number {
  const children = Array.isArray(node?.children) ? node.children : []
  let count = 0
  for (const c of children) {
    if (String(c?.type ?? '') === 'BOOLEAN_OPERATION') count++
    count += countBooleanDescendants(c)
  }
  return count
}

function toBase64(u8: Uint8Array): string {
  // Uint8Array -> base64 (no Buffer dependency)
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk))
  }
  // @ts-ignore
  return btoa(s)
}

mg.ui.onmessage = (msg: { type: UIMessage, data: any }) => {
  const { type } = msg

  if (type === UIMessage.REQUEST_FILTERABLE_NODES) {
    const currentPage = mg?.document?.currentPage
    const selection = currentPage?.selection || []

    const collect = (n: any, acc: any[]) => {
      acc.push(n)
      // BOOLEAN_OPERATION：把它和它的子层当作一个整体参与匹配
      // 所以这里不再展开其子孙节点，避免子节点被单独拿去和库比对
      if (String(n?.type ?? '') === 'BOOLEAN_OPERATION') return
      const kids = n?.children
      if (Array.isArray(kids)) for (const k of kids) collect(k, acc)
    }

    const flatList: any[] = []
    for (const s of selection) collect(s, flatList)

    const extractFromPen = (pen: any) => {
      const data = pen?.penPaths?.data
      return typeof data === 'string' && data.length > 0 ? [data] : []
    }

    const filterNodes = flatList.filter((n: any) => {
      if (!isShapeLikeNode(n)) return false
      if (!passSizeAndAspectFilter(n)) return false
      // BOOLEAN_OPERATION 允许无 fills/strokes：flatten 后仍能得到几何 paths
      if (String(n?.type ?? '') === 'BOOLEAN_OPERATION') return true
      return passVisiblePaintFilter(n)
    })

    console.log('[D2I] filterNodes', filterNodes.map((n: any) => ({
      id: n?.id,
      name: n?.name,
      type: n?.type,
      boolDescendants: countBooleanDescendants(n),
    })))

    Promise.all(filterNodes
      .map(async (node: any) => {
          const base = {
            id: node.id,
            name: node.name,
            type: node.type,
            width: node.width,
            height: node.height,
          }

          let paths: string[] = []

          try {
            if (node.type === 'PEN') {
              paths = extractFromPen(node)
            } else {
              const clone = node.clone?.()
              if (!clone) {
                return null
              } else {
                const pen = mg.flatten([clone])

                try {
                  clone.remove?.()
                } catch (e: any) {
                }
                paths = pen ? extractFromPen(pen) : []
                try {
                  pen?.remove?.()
                } catch (e: any) {
                }
              }
            }
          } catch (e: any) {
            return null
          }

          // 复杂度过滤（path 指令总量）
          if (!passComplexityFilter(paths)) {
            console.log('[D2I] complexity filtered', {
              id: base.id,
              type: base.type,
              pathCount: paths.length,
            })
            return null
          }

          let previewDataUrl: string | undefined
          try {
            const png = await node.exportAsync?.({
              format: 'PNG',
              constraint: { type: 'WIDTH', value: 64 },
            })
            if (png && png instanceof Uint8Array) {
              previewDataUrl = `data:image/png;base64,${toBase64(png)}`
            }
          } catch {
            // ignore preview failures
          }

          return { ...base, paths, previewDataUrl }
        })
    ).then((nodes) => {
      const filtered = nodes.filter((x: any) => x !== null)
      sendMsgToUI({
        type: PluginMessage.FILTERABLE_NODES,
        data: filtered,
      })
    })
  }
  if (type === UIMessage.SELECT_NODE) {
    const nodeId = msg?.data?.nodeId
    if (typeof nodeId !== 'string' || nodeId.length === 0) return

    const node = mg.getNodeById(nodeId)
    if (!node) {
      mg.notify(`未找到节点：${nodeId}`)
      return
    }

    try {
      mg.document.currentPage.selection = [node as any]
      mg.viewport.scrollAndZoomIntoView([node as any])
    } catch {
      // ignore
    }
  }
}