<script setup>
/**
 * Page scaffold following the Vuetify "hero toolbar + overlapping inset card"
 * pattern: an outer card holds a primary extended toolbar (hero) and an inner
 * content card pulled up with mt-n16 and inset with horizontal margins, so the
 * primary colour shows as spacing on the left/right inside the hero.
 *
 * Slots: #hero-title, #hero-subtitle, #hero-actions, #toolbar-title,
 *        #toolbar-actions, default.
 */
defineProps({
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  icon: { type: String, default: '' },
  back: { type: String, default: '' },
  // Stretch the content card to fill the viewport height (default slot scrolls
  // internally) instead of growing with its content.
  fill: { type: Boolean, default: false },
});
</script>

<template>
  <v-card flat tile class="page-shell border-0" :class="{ 'shell-fill': fill }">
    <!-- Hero band. extension-height == content card's negative margin, so the
         title row IS the full visible blue band → title is vertically centered. -->
    <v-toolbar color="primary" flat extended height="112" extension-height="48" class="hero-toolbar">
      <v-btn v-if="back" icon variant="text" :to="back" class="me-2"><v-icon icon="mdi-arrow-left" /></v-btn>

      <div class="hero-titles">
        <div class="hero-line d-flex align-center ga-2 font-weight-bold">
          <slot name="hero-title">
            <v-icon v-if="icon" :icon="icon" />
            {{ title }}
          </slot>
        </div>
        <div v-if="$slots['hero-subtitle']" class="hero-sub">
          <slot name="hero-subtitle" />
        </div>
      </div>

      <v-spacer />
      <div class="d-flex align-center ga-1 flex-wrap justify-end">
        <slot name="hero-actions" />
      </div>
    </v-toolbar>

    <!-- Inner content card: overlaps the hero, inset left/right for blue spacing -->
    <v-card class="content-card border-0 mx-6 mt-n12 mb-6" elevation="0" rounded="lg">
      <template v-if="subtitle || $slots['toolbar-title'] || $slots['toolbar-actions']">
        <v-toolbar color="surface" flat density="comfortable">
          <v-toolbar-title class="text-subtitle-1 font-weight-medium">
            <slot name="toolbar-title">{{ subtitle }}</slot>
          </v-toolbar-title>
          <template #append>
            <div class="d-flex align-center ga-1">
              <slot name="toolbar-actions" />
            </div>
          </template>
        </v-toolbar>
        <v-divider />
      </template>
      <div class="pa-4">
        <slot />
      </div>
    </v-card>
  </v-card>
</template>

<style scoped>
.page-shell {
  overflow: hidden;
}
/* Inset the hero title + actions from the blue edges (aligned with the card's mx-6) */
.hero-toolbar :deep(.v-toolbar__content) {
  padding-inline: 24px;
}
.hero-titles {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
}
.hero-line {
  font-size: 1.2rem;
}
.hero-sub {
  font-size: 0.78rem;
  opacity: 0.85;
  margin-top: 3px;
}
.content-card {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}

/* Fill mode: stretch the whole shell to the viewport, with the content card's
   inner slot taking the remaining height (and scrolling there if needed). The
   bottom margin mirrors the card's left/right inset for symmetric spacing. */
.shell-fill {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.shell-fill .hero-toolbar {
  flex: 0 0 auto;
}
.shell-fill .content-card {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.shell-fill .content-card > .v-toolbar,
.shell-fill .content-card > hr {
  flex: 0 0 auto;
}
.shell-fill .content-card > .pa-4 {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
