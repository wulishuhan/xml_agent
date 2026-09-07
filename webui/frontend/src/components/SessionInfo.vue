<template>
  <section v-if="session" class="panel">
    <div class="panel-title">Session</div>

    <div class="session-info">
      <div>
        <span>ID</span>

        <code>
          {{ session.id }}
        </code>
      </div>

      <div>
        <span>Workspace</span>

        <code>
          {{ session.workspace }}
        </code>
      </div>

      <div>
        <span>Task</span>

        <div class="task">
          {{ session.task }}
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
defineProps({
  session: {
    type: Object,
    default: null,
  },
});
</script>
