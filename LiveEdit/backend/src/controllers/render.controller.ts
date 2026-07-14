import { Request, Response } from 'express';

/**
 * POST /api/render
 * Placeholder endpoint for the future render/export pipeline.
 * Intentionally does not invoke FFmpeg - returns a stub job descriptor
 * so the frontend can be built against a stable contract.
 */
export function requestRender(req: Request, res: Response): void {
  const { format, outputPath } = req.body as { format?: string; outputPath?: string };

  res.status(202).json({
    success: true,
    data: {
      jobId: `render-${Date.now()}`,
      status: 'queued',
      format: format ?? 'mp4',
      outputPath: outputPath ?? null,
      message: 'Render pipeline not yet implemented. Job accepted for future processing.',
    },
  });
}
