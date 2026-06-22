<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';

const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const username = ref('');
const password = ref('');
const password2 = ref('');
const displayName = ref('');
const showPass = ref(false);
const loading = ref(false);
const error = ref('');

// First-run: no admin exists yet → show the setup form instead of login.
const isSetup = computed(() => auth.needsSetup);

onMounted(async () => {
  try {
    await auth.checkStatus();
  } catch {
    /* backend unreachable; show login */
  }
});

async function submit() {
  error.value = '';
  if (isSetup.value && password.value !== password2.value) {
    error.value = t('auth.passwordMismatch');
    return;
  }
  loading.value = true;
  try {
    if (isSetup.value) {
      await auth.setup({
        username: username.value,
        password: password.value,
        displayName: displayName.value,
      });
    } else {
      await auth.login(username.value, password.value);
    }
    const dest = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard';
    router.replace(dest);
  } catch (e) {
    // Only trust a string error from the API; some servers (or a wrong proxy
    // target) return `error: true` or an object, which would render an empty alert.
    const apiError = e.response?.data?.error;
    error.value = (typeof apiError === 'string' && apiError) || e.message || t('auth.failed');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-wrap d-flex align-center justify-center">
    <v-card variant="elevated" class="pa-2" elevation="8" rounded="xl" width="420" max-width="92vw">
      <v-card-item class="text-center pt-6">
        <v-avatar color="primary" variant="tonal" rounded="lg" size="64" class="mx-auto mb-3">
          <v-icon icon="mdi-shield-account" size="34" />
        </v-avatar>
        <v-card-title class="text-h5 font-weight-bold">HelMiO</v-card-title>
        <v-card-subtitle>{{
          isSetup ? t('auth.setupSubtitle') : t('auth.loginSubtitle')
        }}</v-card-subtitle>
      </v-card-item>

      <v-card-text>
        <v-alert
          v-if="isSetup"
          type="info"
          variant="tonal"
          density="compact"
          class="mb-4"
          :text="t('auth.setupHint')"
        />
        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          density="compact"
          class="mb-4"
          :text="error"
        />

        <v-form @submit.prevent="submit">
          <v-text-field
            v-model="username"
            :label="t('auth.username')"
            prepend-inner-icon="mdi-account"
            variant="outlined"
            density="comfortable"
            autocomplete="username"
            autofocus
            class="mb-2"
          />
          <v-text-field
            v-if="isSetup"
            v-model="displayName"
            :label="t('auth.displayName')"
            prepend-inner-icon="mdi-badge-account-horizontal"
            variant="outlined"
            density="comfortable"
            class="mb-2"
          />
          <v-text-field
            v-model="password"
            :label="t('auth.password')"
            :type="showPass ? 'text' : 'password'"
            prepend-inner-icon="mdi-lock"
            :append-inner-icon="showPass ? 'mdi-eye-off' : 'mdi-eye'"
            variant="outlined"
            density="comfortable"
            :autocomplete="isSetup ? 'new-password' : 'current-password'"
            class="mb-2"
            @click:append-inner="showPass = !showPass"
          />
          <v-text-field
            v-if="isSetup"
            v-model="password2"
            :label="t('auth.passwordConfirm')"
            :type="showPass ? 'text' : 'password'"
            prepend-inner-icon="mdi-lock-check"
            variant="outlined"
            density="comfortable"
            autocomplete="new-password"
            class="mb-2"
          />
          <v-btn type="submit" color="primary" size="large" block :loading="loading" class="mt-2">
            {{ isSetup ? t('auth.createAdmin') : t('auth.signIn') }}
          </v-btn>
        </v-form>
      </v-card-text>
    </v-card>
  </div>
</template>

<style scoped>
/* Full-viewport branded backdrop: a pair of radial gradients with no Vuetify
   utility equivalent. Centering is handled by d-flex utilities in the template. */
.login-wrap {
  min-height: 100vh;
  background:
    radial-gradient(900px 500px at 20% -10%, rgba(79, 124, 255, 0.18), transparent 60%),
    radial-gradient(800px 500px at 100% 110%, rgba(124, 92, 255, 0.16), transparent 55%);
}
</style>
