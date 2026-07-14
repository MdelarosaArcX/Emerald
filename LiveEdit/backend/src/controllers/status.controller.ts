import { Request, Response } from 'express';
import { systemStatus } from '../data/mockData';

/**
 * GET /api/status
 * Returns current system/connection/recording status for the toolbar.
 * In a future iteration this would be sampled from real OS/process metrics.
 */
export function getStatus(_req: Request, res: Response): void {
  systemStatus.cpuUsage = clamp(systemStatus.cpuUsage + jitter(), 5, 95);
  systemStatus.memoryUsage = clamp(systemStatus.memoryUsage + jitter(), 10, 90);

  res.json({ success: true, data: systemStatus });
}

function jitter(): number {
  return Math.round((Math.random() - 0.5) * 6);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
