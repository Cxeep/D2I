
<template>
  <div style="padding: 8px;">
    <button @click="filterIconfont" style="margin-right: 8px;">
      筛选可用 iconfont 的图形
    </button>
    <label style="font-size: 12px; opacity: .85;">
      阈值：
      <input type="number" v-model.number="threshold" step="0.01" min="0" max="1" style="width: 72px;" />
    </label>

    <div style="margin-top: 12px; font-size: 12px; opacity: .7;">
      iconfont 库：{{ iconLibraryStatus }}
    </div>

    <div style="margin-top: 12px;">
      <div v-if="results.length === 0" style="opacity: .8;">暂无结果（请先选中一个 Frame/组/图形后点击按钮）</div>
      <div v-for="r in results" :key="r.nodeId" style="display:flex; gap:10px; align-items:center; margin-bottom: 10px;" @click="selectNode(r.nodeId)">
        <img
          v-if="r.previewDataUrl"
          :src="r.previewDataUrl"
          width="40"
          height="40"
          style="border:1px solid #eee; border-radius:6px; cursor:pointer;"
          title="点击选中原型图节点"
        />
        <div v-else style="width:40px;height:40px;border:1px solid #eee;border-radius:6px;display:flex;align-items:center;justify-content:center;opacity:.6;">—</div>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            {{ r.nodeName }} <span style="opacity:.6;">({{ r.nodeType }})</span>
          </div>
          <div style="opacity:.75; font-size:12px;">
            建议：{{ r.iconName }} — {{ r.score.toFixed(3) }}
          </div>
        </div>
        <img v-if="r.iconPreviewDataUrl" :src="r.iconPreviewDataUrl" width="40" height="40" style="border:1px solid #eee; border-radius:6px;" />
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import {
  PluginMessage,
  subscribePluginMessages,
  requestFilterableNodes,
  requestSelectNode,
} from '@lib/plugin-request'
import {
  radialFourierMagnitudeFromPathData,
  cosineSimilarity,
  meanVector,
} from '@lib/iconfont'
import iconLibraryGenerated from '@lib/icon-library.generated.json'
import { dHashFromMask, dHashSimilarity, maskDataUrl } from '@lib/perceptual-hash'

const threshold = ref(0.75)
const results = ref<Array<{
  nodeId: string
  nodeName: string
  nodeType: string
  previewDataUrl?: string
  iconId: string
  iconName: string
  score: number
  iconPreviewDataUrl?: string
}>>([])

type IconDef = { id: string; name: string; paths: string[]; descriptor?: number[] }

const ICON_LIBRARY: IconDef[] = []
const iconLibraryStatus = ref<string>('未加载')
const iconDHashCache = new Map<string, bigint>()

function setIconLibrary(list: Array<{ id: string; name: string; paths: string[] }>) {
  ICON_LIBRARY.splice(0, ICON_LIBRARY.length)
  for (const x of list) ICON_LIBRARY.push({ ...x })
}

function loadIconsFromGeneratedLibrary() {
  if (ICON_LIBRARY.length > 0) return
  if (Array.isArray(iconLibraryGenerated)) {
    setIconLibrary(iconLibraryGenerated as any)
    iconLibraryStatus.value = `从生成文件加载：${ICON_LIBRARY.length} 个`
  } else {
    iconLibraryStatus.value = '生成的 ICON_LIBRARY 文件格式不正确'
  }
}

function ensureIconDescriptors() {
  if (ICON_LIBRARY.length === 0) loadIconsFromGeneratedLibrary()
  for (const icon of ICON_LIBRARY) {
    if (icon.descriptor) continue
    if (!icon.paths || icon.paths.length === 0) continue
    const vecs = icon.paths.map(d => radialFourierMagnitudeFromPathData(d, 64, 256, 16))
    icon.descriptor = meanVector(vecs.filter(v => v.length))
  }
}

function getIconDHash(icon: IconDef): bigint | null {
  const cached = iconDHashCache.get(icon.id)
  if (cached !== undefined) return cached
  const h = dHashFromMask(icon.paths, { size: 96, paddingFrac: 0.08 })
  if (h === null) return null
  iconDHashCache.set(icon.id, h)
  return h
}

function handlePluginMessage(msg: { type: PluginMessage; data?: unknown }) {
  const { type, data } = msg
  if (type === PluginMessage.FILTERABLE_NODES) {
    ensureIconDescriptors()

    const out: typeof results.value = []
    for (const node of (data as any[])) {
      const paths: string[] = Array.isArray(node.paths) ? node.paths : []
      if (!paths.length) continue
      if (node.error) continue

      const nodeVecs = paths.map((d) => radialFourierMagnitudeFromPathData(d, 64, 256, 16))
      const nodeDesc = meanVector(nodeVecs.filter((v) => v.length))

      const geomTopN = 25
      const geomCandidates = ICON_LIBRARY
        .map((icon) => ({ icon, geom: icon.descriptor ? cosineSimilarity(nodeDesc, icon.descriptor) : -Infinity }))
        .filter((x) => Number.isFinite(x.geom))
        .sort((a, b) => b.geom - a.geom)
        .slice(0, geomTopN)

      const nodeHash = dHashFromMask(paths, { size: 96, paddingFrac: 0.08 })
      let best: { icon: IconDef; score: number } | null = null
      for (const { icon, geom } of geomCandidates) {
        const iconHash = getIconDHash(icon)
        const ph = nodeHash !== null && iconHash !== null ? dHashSimilarity(nodeHash, iconHash) : 0
        const score = 0.6 * geom + 0.4 * ph
        if (!best || score > best.score) best = { icon, score }
      }
      if (!best) continue
      if (best.score < threshold.value) continue

      out.push({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        previewDataUrl: node.previewDataUrl,
        iconId: best.icon.id,
        iconName: best.icon.name,
        score: best.score,
        iconPreviewDataUrl: maskDataUrl(best.icon.paths, { size: 64, paddingFrac: 0.1 }) ?? undefined,
      })
    }

    results.value = out.sort((a, b) => b.score - a.score)
  }
}

function filterIconfont() {
  results.value = []
  requestFilterableNodes()
}

function selectNode(nodeId: string) {
  requestSelectNode(nodeId)
}

onMounted(() => {
  const unsub = subscribePluginMessages((msg) => handlePluginMessage(msg))
  onBeforeUnmount(unsub)
  loadIconsFromGeneratedLibrary()
})
</script>
