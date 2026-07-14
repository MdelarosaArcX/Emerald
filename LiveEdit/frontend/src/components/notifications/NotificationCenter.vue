<script setup lang="ts">
/**
 * Toast-style notification stack. Notifications are pushed via the
 * exposed `push` method (e.g. from socket event handlers) and
 * auto-dismiss after a few seconds.
 */
import { CheckCircleIcon, ExclamationTriangleIcon, InformationCircleIcon, XCircleIcon } from '@heroicons/vue/24/solid';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import { ref } from 'vue';

type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

interface Notification {
  id: number;
  level: NotificationLevel;
  title: string;
  message?: string;
}

const notifications = ref<Notification[]>([]);
let nextId = 1;

const icons: Record<NotificationLevel, typeof InformationCircleIcon> = {
  info: InformationCircleIcon,
  success: CheckCircleIcon,
  warning: ExclamationTriangleIcon,
  error: XCircleIcon,
};

const colors: Record<NotificationLevel, string> = {
  info: 'text-teal-400 border-teal-500/30',
  success: 'text-emerald-400 border-emerald-500/30',
  warning: 'text-amber-400 border-amber-500/30',
  error: 'text-rose-400 border-rose-500/30',
};

function push(level: NotificationLevel, title: string, message?: string): void {
  const id = nextId++;
  notifications.value.push({ id, level, title, message });
  window.setTimeout(() => dismiss(id), 5000);
}

function dismiss(id: number): void {
  notifications.value = notifications.value.filter((n) => n.id !== id);
}

defineExpose({ push });
</script>

<template>
  <div class="pointer-events-none fixed right-4 top-16 z-50 flex w-80 flex-col gap-2">
    <TransitionGroup name="toast">
      <div
        v-for="n in notifications"
        :key="n.id"
        class="pointer-events-auto flex items-start gap-2 rounded-lg border bg-surface-850/95 p-3 shadow-panel backdrop-blur"
        :class="colors[n.level]"
      >
        <component :is="icons[n.level]" class="mt-0.5 h-4 w-4 shrink-0" />
        <div class="flex-1">
          <p class="text-xs font-semibold text-slate-100">{{ n.title }}</p>
          <p v-if="n.message" class="mt-0.5 text-[11px] text-slate-400">{{ n.message }}</p>
        </div>
        <button class="text-slate-500 hover:text-slate-300" @click="dismiss(n.id)">
          <XMarkIcon class="h-3.5 w-3.5" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(20px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
</style>
