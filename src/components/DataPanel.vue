<script setup>
/**
 * Standard list-page panel: a single flat card that holds an optional filter
 * row and a viewport-fitted body (table / cards / empty states), so every page
 * shares the same surface, spacing, corner radius and table height.
 *
 * The filter row sits on the SAME surface as the body directly above it (no
 * gap), right-aligned with a consistent gap. The body is height-fitted to the
 * viewport via useFitHeight; the computed `height` is exposed as a slot prop so
 * the page can hand it to its <v-data-table :height> (or a scroll container).
 * The table scrolls internally with fixed-header — the page itself never scrolls.
 *
 * Usage:
 *   <DataPanel>
 *     <template #filters> …search / selects… </template>
 *     <template #default="{ height }">
 *       <v-data-table :height="height" fixed-header … />
 *     </template>
 *     <template #footer> …showing N of M… </template>   (optional)
 *   </DataPanel>
 */
import { ref } from 'vue'
import { useFitHeight } from '@/composables/useFitHeight'

const props = defineProps({
  // Space (px) reserved below the body. Bump it when a #footer strip is present.
  bottomGap: { type: Number, default: 24 }
})

const wrap = ref(null)
const { height, recalc } = useFitHeight(wrap, { bottom: props.bottomGap })

defineExpose({ recalc })
</script>

<template>
  <v-card variant="flat" rounded="lg" class="data-panel">
    <!-- Filter row — same surface as the body below it, right-aligned -->
    <div v-if="$slots.filters" class="pa-3 d-flex align-center justify-end ga-2 flex-wrap">
      <slot name="filters" />
    </div>

    <!-- Viewport-fitted body (table scrolls inside, fixed-header) -->
    <div ref="wrap">
      <slot :height="height" :recalc="recalc" />
    </div>

    <slot name="footer" />
  </v-card>
</template>
