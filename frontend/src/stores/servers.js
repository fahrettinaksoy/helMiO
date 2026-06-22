import { defineStore } from 'pinia';
import { ref } from 'vue';
import { serversApi } from '@/api/client';

export const useServersStore = defineStore('servers', () => {
  const servers = ref([]);
  const methods = ref([]);
  const loading = ref(false);
  const error = ref(null);

  async function fetchMethods() {
    if (methods.value.length) return methods.value;
    methods.value = await serversApi.methods();
    return methods.value;
  }

  async function fetchAll() {
    loading.value = true;
    error.value = null;
    try {
      servers.value = await serversApi.list();
    } catch (e) {
      error.value = e.response?.data?.error || e.message;
    } finally {
      loading.value = false;
    }
  }

  async function create(data) {
    const server = await serversApi.create(data);
    servers.value.push(server);
    return server;
  }

  async function update(id, data) {
    const server = await serversApi.update(id, data);
    const idx = servers.value.findIndex((s) => s.id === id);
    if (idx !== -1) servers.value[idx] = server;
    return server;
  }

  async function remove(id) {
    await serversApi.remove(id);
    servers.value = servers.value.filter((s) => s.id !== id);
  }

  async function test(id) {
    return serversApi.test(id);
  }

  function byId(id) {
    return servers.value.find((s) => s.id === id) || null;
  }

  return {
    servers,
    methods,
    loading,
    error,
    fetchMethods,
    fetchAll,
    create,
    update,
    remove,
    test,
    byId,
  };
});
