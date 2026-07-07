import { createRouter, createWebHistory } from "vue-router";
import CapturePage from "../pages/CapturePage.vue";
import PlaybackPage from "../pages/PlaybackPage.vue";

export const router = createRouter({
  history: createWebHistory(),
  linkExactActiveClass: "active",
  routes: [
    { path: "/", name: "capture", component: CapturePage },
    { path: "/playback", name: "playback", component: PlaybackPage },
  ],
});
