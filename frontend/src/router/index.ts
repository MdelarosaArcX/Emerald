import { createRouter, createWebHistory } from "vue-router";
import CapturePage from "../pages/CapturePage.vue";
import PlaybackPage from "../pages/PlaybackPage.vue";
import MonitorPage from "../pages/MonitorPage.vue";

export const router = createRouter({
  history: createWebHistory(),
  linkExactActiveClass: "active",
  routes: [
    { path: "/", name: "capture", component: CapturePage },
    { path: "/playback", name: "playback", component: PlaybackPage },
    // Video-only, no app chrome (see App.vue) — meant to be opened standalone on another
    // machine on the network, not navigated to via the primary nav. Capture/on-air are separate
    // routes (not just a toggle) so each can be opened on its own machine/tab independently.
    { path: "/monitor", name: "monitor", component: MonitorPage, meta: { chromeless: true } },
    { path: "/monitor/capture", name: "monitor-capture", component: MonitorPage, meta: { chromeless: true, monitorMode: "capture" } },
    { path: "/monitor/onair", name: "monitor-onair", component: MonitorPage, meta: { chromeless: true, monitorMode: "onair" } },
  ],
});
