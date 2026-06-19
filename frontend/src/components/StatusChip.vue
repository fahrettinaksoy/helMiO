<script setup>
import { computed } from 'vue';
import { stateStyle } from '@/utils/format';

const props = defineProps({
  statename: { type: String, required: true },
  size: { type: String, default: 'small' },
});

const style = computed(() => stateStyle(props.statename));
</script>

<template>
  <v-chip :color="style.color" :size="size" variant="flat" label>
    <v-icon start :icon="style.icon" />
    {{ statename }}
  </v-chip>
</template>
