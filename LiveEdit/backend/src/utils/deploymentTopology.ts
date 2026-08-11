import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import dns from 'node:dns/promises';
import { logger } from './logger';

/**
 * Is the given backend hostname (e.g. from EMERALD_BACKEND_URL) this same physical machine?
 * Used to skip fetching recording files over HTTP and read them straight off local disk instead
 * (see recordingCaptureSync.service.ts) — only meaningful for this app's common single-workstation
 * deployment (Emerald backend, LiveEdit backend, and the operator's browser all on one box); on a
 * multi-machine LAN setup this correctly evaluates false and playback just stays over HTTP.
 */
async function checkSameMachine(hostname: string): Promise<boolean> {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;

  let targetIp = hostname;
  if (!isIP(hostname)) {
    try {
      targetIp = (await dns.lookup(hostname)).address;
    } catch (err) {
      logger.warn(`deploymentTopology: could not resolve host '${hostname}'`, err);
      return false;
    }
  }

  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.address === targetIp) return true;
    }
  }
  return false;
}

// Cached per hostname — network interfaces don't change during a process's lifetime, and this
// gets checked on every sync poll tick (every ~10s), so there's no reason to re-resolve DNS or
// re-enumerate interfaces each time.
const cache = new Map<string, Promise<boolean>>();

export function isSameMachine(hostname: string): Promise<boolean> {
  let result = cache.get(hostname);
  if (!result) {
    result = checkSameMachine(hostname);
    cache.set(hostname, result);
  }
  return result;
}
