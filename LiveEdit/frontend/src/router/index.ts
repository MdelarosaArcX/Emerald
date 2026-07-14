import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'dashboard',
    component: () => import('@/views/DashboardView.vue'),
    meta: { title: 'Dashboard' },
  },
  {
    path: '/editor',
    name: 'editor',
    component: () => import('@/views/EditorView.vue'),
    meta: { title: 'Live Editor' },
  },
  {
    path: '/media',
    name: 'media',
    component: () => import('@/views/MediaBrowserView.vue'),
    meta: { title: 'Media Browser' },
  },
  {
    path: '/capture',
    name: 'capture',
    component: () => import('@/views/CaptureView.vue'),
    meta: { title: 'Capture' },
  },
  {
    path: '/playback',
    name: 'playback',
    component: () => import('@/views/PlaybackView.vue'),
    meta: { title: 'Playback' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { title: 'Settings' },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${String(to.meta.title)} · Emerald Live Edit` : 'Emerald Live Edit';
});

export default router;
