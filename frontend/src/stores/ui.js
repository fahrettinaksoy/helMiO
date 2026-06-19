import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * Global UI state for panels that must be openable from anywhere (e.g. the
 * "Add server" form, triggered from the left server list on any page).
 */
export const useUiStore = defineStore('ui', () => {
  const serverFormOpen = ref(false);
  const serverFormTarget = ref(null); // server to edit, or null for add

  function openAddServer() {
    serverFormTarget.value = null;
    serverFormOpen.value = true;
  }
  function openEditServer(server) {
    serverFormTarget.value = server;
    serverFormOpen.value = true;
  }

  return { serverFormOpen, serverFormTarget, openAddServer, openEditServer };
});
