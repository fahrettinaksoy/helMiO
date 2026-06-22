<script setup>
/**
 * Generic slide-over side panel. Teleported to <body> and fixed-positioned so it
 * overlays EVERYTHING — app bar, navigation drawer and footer included — unlike a
 * layout-integrated v-navigation-drawer.
 *
 * z-index sits above layout chrome (~1005) but below Vuetify's overlay layer
 * (2000+), so v-select menus, tooltips and menus opened inside still render on top.
 *
 * Usage:
 *   <SidePanel v-model="open" title="Başlık" icon="mdi-cog" :width="560">
 *     ...content...
 *     <template #footer="{ close }"> <v-btn @click="close">Kapat</v-btn> </template>
 *   </SidePanel>
 */
import { computed, watch, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  icon: { type: String, default: '' },
  width: { type: [Number, String], default: 520 },
  location: { type: String, default: 'right' }, // 'right' | 'left'
  persistent: { type: Boolean, default: false }, // scrim/esc won't close
});
const emit = defineEmits(['update:modelValue']);

const widthPx = computed(() => (typeof props.width === 'number' ? `${props.width}px` : props.width));
const transitionName = computed(() => (props.location === 'left' ? 'sp-slide-left' : 'sp-slide-right'));

function close() {
  if (!props.persistent) emit('update:modelValue', false);
}

function onScrim() {
  close();
}

function onKey(e) {
  if (e.key === 'Escape' && props.modelValue) close();
}

// Lock page scroll while open and restore on close/unmount.
watch(
  () => props.modelValue,
  (open) => {
    document.documentElement.style.overflow = open ? 'hidden' : '';
  },
  { immediate: true }
);

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  document.documentElement.style.overflow = '';
});
</script>

<template>
  <teleport to="body">
    <transition name="sp-fade">
      <div v-if="modelValue" class="sp-scrim" @click="onScrim" />
    </transition>

    <transition :name="transitionName">
      <v-card
        v-if="modelValue"
        class="sp-panel d-flex flex-column"
        :class="`sp-${location}`"
        :style="{ width: widthPx }"
        color="background"
        elevation="24"
        rounded="0"
        role="dialog"
        aria-modal="true"
      >
        <header class="d-flex align-center ga-1 ps-4 pe-2 py-2 flex-grow-0" style="min-height: 56px">
          <slot name="header" :close="close">
            <v-icon v-if="icon" :icon="icon" class="me-2" />
            <span class="text-subtitle-1 font-weight-medium text-truncate">{{ title }}</span>
            <v-spacer />
            <v-btn icon="mdi-close" variant="text" size="small" @click="close" />
          </slot>
        </header>
        <v-divider />

        <div class="flex-grow-1 overflow-y-auto">
          <slot :close="close" />
        </div>

        <template v-if="$slots.footer">
          <v-divider />
          <footer class="d-flex ga-2 pa-3 flex-grow-0">
            <slot name="footer" :close="close" />
          </footer>
        </template>
      </v-card>
    </transition>
  </teleport>
</template>

<style scoped>
/* Consistent, comfortable vertical rhythm for every form opened in a drawer.
   The global `hideDetails: 'auto'` default removes each field's message slot,
   so without this fields stack tightly together. Applied at the panel level so
   all drawer forms (servers, users, channels, tokens) share the same spacing.
   `!important` overrides per-field mb-* utility classes for one uniform gap. */
.sp-panel :deep(.v-input) { margin-bottom: 16px !important; }

/* Fixed-positioned overlay glue with no Vuetify-prop equivalent.
   z-index sits above layout chrome (app bar ~1005, footer) but below
   Vuetify overlays (2000+) so menus/tooltips opened inside still render on top. */
.sp-scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 1900;
}
.sp-panel {
  position: fixed;
  top: 0;
  bottom: 0;
  height: 100dvh;
  max-width: 100vw;
  z-index: 1901;
}
.sp-right {
  right: 0;
}
.sp-left {
  left: 0;
}

/* scrim fade */
.sp-fade-enter-active,
.sp-fade-leave-active {
  transition: opacity 0.2s ease;
}
.sp-fade-enter-from,
.sp-fade-leave-to {
  opacity: 0;
}

/* slide from right */
.sp-slide-right-enter-active,
.sp-slide-right-leave-active {
  transition: transform 0.25s ease;
}
.sp-slide-right-enter-from,
.sp-slide-right-leave-to {
  transform: translateX(100%);
}

/* slide from left */
.sp-slide-left-enter-active,
.sp-slide-left-leave-active {
  transition: transform 0.25s ease;
}
.sp-slide-left-enter-from,
.sp-slide-left-leave-to {
  transform: translateX(-100%);
}
</style>
