<script setup>
/**
 * Dependency-free SVG trend chart. Renders one or more time series as smooth
 * area/line plots with a shared, auto-scaled Y axis. No chart library — keeps
 * the bundle lean and the styling theme-aware.
 *
 * Props:
 *   series: [{ name, color, points: [{ at: epochMs, v: number|null }] }]
 *   height: px (default 120)
 *   unit:   string appended to value labels (e.g. '%', ' MB')
 *   yMax:   optional fixed max (else auto from data)
 */
import { computed, ref } from 'vue'

const props = defineProps({
  series: { type: Array, default: () => [] },
  height: { type: Number, default: 120 },
  unit: { type: String, default: '' },
  yMax: { type: Number, default: null }
})

const W = 600 // viewBox width; the SVG scales to its container via width=100%
const H = computed(() => props.height)
const PAD = { t: 8, r: 8, b: 16, l: 36 }

const allPoints = computed(() => props.series.flatMap((s) => s.points || []))
const hasData = computed(() => allPoints.value.some((p) => p.v != null))

const xRange = computed(() => {
  const ats = allPoints.value.map((p) => p.at)
  if (!ats.length) return [0, 1]
  const min = Math.min(...ats)
  const max = Math.max(...ats)
  return [min, max === min ? min + 1 : max]
})

const yRange = computed(() => {
  const vs = allPoints.value.map((p) => p.v).filter((v) => v != null)
  const max = props.yMax != null ? props.yMax : vs.length ? Math.max(...vs) : 1
  return [0, max <= 0 ? 1 : max * 1.1]
})

function sx(at) {
  const [a, b] = xRange.value
  return PAD.l + ((at - a) / (b - a)) * (W - PAD.l - PAD.r)
}
function sy(v) {
  const [a, b] = yRange.value
  return H.value - PAD.b - ((v - a) / (b - a)) * (H.value - PAD.t - PAD.b)
}

// Build a path, breaking the line on null gaps.
function linePath(points) {
  let d = ''
  let pen = false
  for (const p of points) {
    if (p.v == null) {
      pen = false
      continue
    }
    d += `${pen ? 'L' : 'M'}${sx(p.at).toFixed(1)},${sy(p.v).toFixed(1)} `
    pen = true
  }
  return d.trim()
}
function areaPath(points) {
  const valid = points.filter((p) => p.v != null)
  if (valid.length < 2) return ''
  const top = valid
    .map((p, i) => `${i ? 'L' : 'M'}${sx(p.at).toFixed(1)},${sy(p.v).toFixed(1)}`)
    .join(' ')
  const base = H.value - PAD.b
  return `${top} L${sx(valid[valid.length - 1].at).toFixed(1)},${base} L${sx(valid[0].at).toFixed(1)},${base} Z`
}

const yTicks = computed(() => {
  const [, max] = yRange.value
  return [0, max / 2, max].map((v) => ({ v, y: sy(v), label: fmt(v) }))
})

function fmt(v) {
  if (v == null) return '—'
  const r = Math.round(v * 10) / 10
  return `${r}${props.unit}`
}

const latest = computed(() =>
  props.series.map((s) => {
    const pts = (s.points || []).filter((p) => p.v != null)
    return { name: s.name, color: s.color, value: pts.length ? pts[pts.length - 1].v : null }
  })
)

// Simple hover readout
const hover = ref(null)
function onMove(e) {
  const svg = e.currentTarget
  const rect = svg.getBoundingClientRect()
  const x = ((e.clientX - rect.left) / rect.width) * W
  const [a, b] = xRange.value
  const at = a + ((x - PAD.l) / (W - PAD.l - PAD.r)) * (b - a)
  // nearest point per series
  const readout = props.series.map((s) => {
    let best = null
    for (const p of s.points || []) {
      if (p.v == null) continue
      if (!best || Math.abs(p.at - at) < Math.abs(best.at - at)) best = p
    }
    return { name: s.name, color: s.color, v: best?.v, at: best?.at }
  })
  hover.value = { x, at, readout }
}
</script>

<template>
  <div class="trend w-100">
    <div class="d-flex align-center mb-1 flex-wrap ga-3">
      <div v-for="l in latest" :key="l.name" class="d-flex align-center ga-1">
        <span class="legend-dot" :style="{ background: l.color }" />
        <span class="text-caption text-medium-emphasis">{{ l.name }}</span>
        <span class="text-caption font-weight-medium">{{ fmt(l.value) }}</span>
      </div>
    </div>

    <svg
      :viewBox="`0 0 ${W} ${H}`"
      class="chart"
      preserveAspectRatio="none"
      @mousemove="onMove"
      @mouseleave="hover = null"
    >
      <!-- y grid + labels -->
      <g v-for="tick in yTicks" :key="tick.v">
        <line :x1="PAD.l" :x2="W - PAD.r" :y1="tick.y" :y2="tick.y" class="grid" />
        <text :x="PAD.l - 4" :y="tick.y + 3" text-anchor="end" class="axis">{{ tick.label }}</text>
      </g>

      <template v-if="hasData">
        <path
          v-for="s in series"
          :key="`a-${s.name}`"
          :d="areaPath(s.points)"
          :fill="s.color"
          fill-opacity="0.12"
        />
        <path
          v-for="s in series"
          :key="`l-${s.name}`"
          :d="linePath(s.points)"
          :stroke="s.color"
          fill="none"
          stroke-width="2"
          vector-effect="non-scaling-stroke"
        />
      </template>
      <text v-else :x="W / 2" :y="H / 2" text-anchor="middle" class="axis">—</text>

      <!-- hover marker -->
      <line v-if="hover" :x1="hover.x" :x2="hover.x" :y1="PAD.t" :y2="H - PAD.b" class="cursor" />
    </svg>

    <div v-if="hover && hasData" class="hover-readout text-caption">
      <span class="text-medium-emphasis">{{
        new Date(hover.readout.find((r) => r.at)?.at || hover.at).toLocaleTimeString()
      }}</span>
      <span v-for="r in hover.readout" :key="r.name" class="ms-2">
        <span class="legend-dot" :style="{ background: r.color }" />{{ fmt(r.v) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.chart {
  width: 100%;
  display: block;
}
.grid {
  stroke: rgba(var(--v-theme-on-surface), 0.08);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.axis {
  fill: rgba(var(--v-theme-on-surface), 0.5);
  font-size: 9px;
  font-family: ui-monospace, monospace;
}
.cursor {
  stroke: rgba(var(--v-theme-on-surface), 0.3);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  stroke-dasharray: 3 3;
}
.legend-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 3px;
  vertical-align: middle;
}
.hover-readout {
  padding: 2px 4px;
}
</style>
