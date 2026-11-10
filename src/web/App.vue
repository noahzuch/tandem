<!-- PLACEHOLDER (F00) — delete in the next feature -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';

const message = ref('…');

onMounted(async () => {
  try {
    const response = await fetch('/api/hello');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { message: string };
    message.value = body.message;
  } catch {
    message.value = 'Server not reachable';
  }
});
</script>

<template>
  <main>
    <h1 data-testid="greeting">{{ message }}</h1>
    <p class="note">Placeholder page (F00). Deleted by the next feature.</p>
  </main>
</template>

<style scoped>
main {
  font-family: system-ui, sans-serif;
  margin: 4rem auto;
  max-width: 40rem;
}
.note {
  color: #666;
}
</style>
