import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * Fit an element to the viewport so its content scrolls *inside* it instead of
 * growing the page. Returns a reactive `height` (px) measured from the wrapped
 * element's top to the bottom of the window, and a `recalc()` to call after the
 * layout changes (e.g. data loaded, filters toggled).
 *
 * Usage:
 *   const wrap = ref(null);
 *   const { height, recalc } = useFitHeight(wrap);
 *   <div ref="wrap"><v-data-table :height="height" fixed-header ... /></div>
 */
export function useFitHeight(wrapRef, { min = 240, bottom = 24 } = {}) {
  const height = ref(420)

  function recalc() {
    const el = wrapRef.value
    if (!el) return
    const top = el.getBoundingClientRect().top
    const h = Math.max(min, Math.floor(window.innerHeight - top - bottom))
    height.value = h
    // Second pass: if the page still overflows (rare), shrink to remove it.
    nextTick(() => {
      const overflow = document.documentElement.scrollHeight - window.innerHeight
      if (overflow > 0) height.value = Math.max(min, h - overflow)
    })
  }

  onMounted(() => {
    recalc()
    // Route transitions (fade out-in), web-font swaps and Vuetify toolbar
    // rendering can shift our top *after* mount, leaving a stale (too-short)
    // height. Re-measure across a few frames so the element fills the viewport.
    requestAnimationFrame(recalc)
    setTimeout(recalc, 120)
    setTimeout(recalc, 360)
    window.addEventListener('resize', recalc)
  })
  onBeforeUnmount(() => window.removeEventListener('resize', recalc))

  return { height, recalc }
}
