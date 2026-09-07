<template>
  <section class="panel console-panel">
    <div class="console-header">
      <div class="panel-title">Agent Console</div>

      <button class="btn btn-small" @click="$emit('clear')">Clear</button>
    </div>

    <div ref="consoleElement" class="console">
      <div v-if="!output.length" class="console-empty">Waiting for agent output...</div>

      <div v-for="(item, index) in output" :key="index" class="console-line" :class="`line-${item.type}`">
        <span class="line-prefix">
          {{ getPrefix(item.type) }}
        </span>

        <span>
          {{ item.content }}
        </span>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, nextTick, watch } from "vue";

const props = defineProps({
  output: {
    type: Array,
    default: () => [],
  },
});

defineEmits(["clear"]);

const consoleElement = ref(null);

watch(
  () => props.output.length,
  async () => {
    await nextTick();

    if (!consoleElement.value) {
      return;
    }

    consoleElement.value.scrollTop = consoleElement.value.scrollHeight;
  },
);

function getPrefix(type) {
  const prefixes = {
    system: "[SYSTEM]",
    stdout: "[OUT]",
    stderr: "[ERR]",
    error: "[ERROR]",
  };

  return prefixes[type] || "[LOG]";
}
</script>
