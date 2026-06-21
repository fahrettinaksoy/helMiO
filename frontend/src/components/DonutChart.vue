<script setup>
/**
 * Dependency-free SVG donut chart. Pass segments as
 *   [{ key, color, value }]   (color = Vuetify theme name, e.g. 'success')
 * Renders proportional arcs with a centred total + label. No chart library.
 */
import { computed } from 'vue';

const props = defineProps({
  segments: { type: Array, default: () => [] },
  size: { type: Number, default: 132 },
  thickness: { type: Number, default: 14 },
  label: { type: String, default: '' },
});

const total = computed(() => props.segments.reduce((a, s) => a + (s.value || 0), 0));
const radius = computed(() => (props.size - props.thickness) / 2);
const circ = computed(() => 2 * Math.PI * radius.value);

// Build stroke-dash arcs around the circle.
const arcs = computed(() => {
  if (!total.value) return [];
  let offset = 0;
  return props.segments.filter((s) => s.value > 0).map((s) => {
    const frac = s.value / total.value;
    const len = frac * circ.value;
    const arc = { color: s.color, dash: `${len} ${circ.value - len}`, offset: -offset };
    offset += len;
    return arc;
  });
});
</script>

<template>
  <div class="donut" :style="{ width: `${size}px`, height: `${size}px` }">
    <svg :viewBox="`0 0 ${size} ${size}`" :width="size" :height="size">
      <g :transform="`rotate(-90 ${size / 2} ${size / 2})`">
        <circle
          :cx="size / 2" :cy="size / 2" :r="radius"
          fill="none" :stroke-width="thickness"
          class="track"
        />
        <circle
          v-for="(a, i) in arcs" :key="i"
          :cx="size / 2" :cy="size / 2" :r="radius"
          fill="none" :stroke-width="thickness" stroke-linecap="butt"
          :stroke="`rgb(var(--v-theme-${a.color}))`"
          :stroke-dasharray="a.dash"
          :stroke-dashoffset="a.offset"
        />
      </g>
    </svg>
    <div class="donut-center">
      <div class="donut-total">{{ total }}</div>
      <div v-if="label" class="donut-label">{{ label }}</div>
    </div>
  </div>
</template>

<style scoped>
.donut { position: relative; flex: 0 0 auto; }
.track { stroke: rgba(var(--v-theme-on-surface), 0.08); }
.donut-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  line-height: 1.1;
}
.donut-total { font-size: 1.5rem; font-weight: 700; }
.donut-label { font-size: 0.66rem; color: rgba(var(--v-theme-on-surface), 0.6); }
</style>
