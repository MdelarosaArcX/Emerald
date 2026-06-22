using System.Diagnostics;

namespace Emerald.Streaming;

public sealed class ObsPreviewService : IDisposable
{
    private readonly object gate = new();
    private readonly string previewRoot;
    private Process? process;

    public ObsPreviewService(string webRootPath)
    {
        previewRoot = Path.Combine(webRootPath, "hls", "obs-preview");
        Directory.CreateDirectory(previewRoot);
    }

    private const string PreviewPath = "/hls/obs-preview/index.m3u8";

    public ObsPreviewStatus Status { get; private set; } = new(false, null, PreviewPath, null);

    public ObsPreviewStatus Start(ObsPreviewRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.InputUrl))
        {
            throw new InvalidOperationException("OBS recording URL is required before preview can start.");
        }

        lock (gate)
        {
            if (IsProcessRunning())
            {
                return Status;
            }

            CleanPreviewFiles();

            var ffmpegPath = NormalizeFfmpegPath(request.FfmpegPath);
            var playlistPath = Path.Combine(previewRoot, "index.m3u8");
            var sessionId = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString();
            var segmentPattern = Path.Combine(previewRoot, $"segment-{sessionId}-%05d.ts");
            var startInfo = new ProcessStartInfo
            {
                FileName = ffmpegPath,
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                CreateNoWindow = true
            };

            AddArguments(startInfo, request.InputUrl.Trim(), segmentPattern, playlistPath);

            var ffmpeg = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            ffmpeg.ErrorDataReceived += (_, args) =>
            {
                if (!string.IsNullOrWhiteSpace(args.Data))
                {
                    Status = Status with { LastMessage = args.Data };
                }
            };
            ffmpeg.Exited += (_, _) =>
            {
                Status = Status with { IsRunning = false, LastMessage = Status.LastMessage ?? "Preview FFmpeg stopped." };
            };

            try
            {
                if (!ffmpeg.Start())
                {
                    throw new InvalidOperationException("Unable to start FFmpeg preview.");
                }
            }
            catch (Exception exception)
            {
                ffmpeg.Dispose();
                process = null;
                Status = Status with { IsRunning = false, LastMessage = exception.Message };
                throw new InvalidOperationException($"Unable to start FFmpeg preview at '{ffmpegPath}'.", exception);
            }

            process = ffmpeg;

            try
            {
                process.BeginErrorReadLine();
                process.BeginOutputReadLine();
            }
            catch (InvalidOperationException)
            {
                // FFmpeg can exit quickly if the stream is not reachable.
            }

            Status = new ObsPreviewStatus(true, DateTimeOffset.UtcNow, $"{PreviewPath}?v={sessionId}", null);
            return Status;
        }
    }

    public ObsPreviewStatus Stop()
    {
        lock (gate)
        {
            if (process is null)
            {
                Status = Status with { IsRunning = false };
                return Status;
            }

            if (!process.HasExited)
            {
                try
                {
                    process.StandardInput.WriteLine("q");
                    if (!process.WaitForExit(5000))
                    {
                        process.Kill(entireProcessTree: true);
                    }
                }
                catch
                {
                    if (!process.HasExited)
                    {
                        process.Kill(entireProcessTree: true);
                    }
                }
            }

            process.Dispose();
            process = null;
            Status = Status with { IsRunning = false, LastMessage = "Preview stopped." };
            return Status;
        }
    }

    public void Dispose()
    {
        Stop();
    }

    private static void AddArguments(ProcessStartInfo startInfo, string inputUrl, string segmentPattern, string playlistPath)
    {
        startInfo.ArgumentList.Add("-hide_banner");
        startInfo.ArgumentList.Add("-loglevel");
        startInfo.ArgumentList.Add("warning");
        startInfo.ArgumentList.Add("-i");
        startInfo.ArgumentList.Add(inputUrl);
        startInfo.ArgumentList.Add("-map");
        startInfo.ArgumentList.Add("0:v:0");
        startInfo.ArgumentList.Add("-map");
        startInfo.ArgumentList.Add("0:a?");
        startInfo.ArgumentList.Add("-c:v");
        startInfo.ArgumentList.Add("libx264");
        startInfo.ArgumentList.Add("-preset");
        startInfo.ArgumentList.Add("veryfast");
        startInfo.ArgumentList.Add("-tune");
        startInfo.ArgumentList.Add("zerolatency");
        startInfo.ArgumentList.Add("-profile:v");
        startInfo.ArgumentList.Add("main");
        startInfo.ArgumentList.Add("-pix_fmt");
        startInfo.ArgumentList.Add("yuv420p");
        startInfo.ArgumentList.Add("-g");
        startInfo.ArgumentList.Add("60");
        startInfo.ArgumentList.Add("-keyint_min");
        startInfo.ArgumentList.Add("60");
        startInfo.ArgumentList.Add("-sc_threshold");
        startInfo.ArgumentList.Add("0");
        startInfo.ArgumentList.Add("-c:a");
        startInfo.ArgumentList.Add("aac");
        startInfo.ArgumentList.Add("-b:a");
        startInfo.ArgumentList.Add("128k");
        startInfo.ArgumentList.Add("-f");
        startInfo.ArgumentList.Add("hls");
        startInfo.ArgumentList.Add("-hls_time");
        startInfo.ArgumentList.Add("2");
        startInfo.ArgumentList.Add("-hls_list_size");
        startInfo.ArgumentList.Add("10");
        startInfo.ArgumentList.Add("-hls_flags");
        startInfo.ArgumentList.Add("delete_segments+append_list+omit_endlist+independent_segments");
        startInfo.ArgumentList.Add("-hls_delete_threshold");
        startInfo.ArgumentList.Add("10");
        startInfo.ArgumentList.Add("-hls_segment_filename");
        startInfo.ArgumentList.Add(segmentPattern);
        startInfo.ArgumentList.Add(playlistPath);
    }

    private bool IsProcessRunning()
    {
        if (process is null)
        {
            return false;
        }

        try
        {
            if (!process.HasExited)
            {
                return true;
            }

            process.Dispose();
            process = null;
            return false;
        }
        catch (InvalidOperationException)
        {
            var failedProcess = process;
            failedProcess?.Dispose();
            process = null;
            Status = Status with { IsRunning = false };
            return false;
        }
    }

    private void CleanPreviewFiles()
    {
        foreach (var file in Directory.EnumerateFiles(previewRoot))
        {
            File.Delete(file);
        }
    }

    private static string NormalizeFfmpegPath(string? configuredPath)
    {
        if (string.IsNullOrWhiteSpace(configuredPath))
        {
            return "ffmpeg";
        }

        var trimmedPath = configuredPath.Trim().Trim('"');

        if (Directory.Exists(trimmedPath))
        {
            return Path.Combine(trimmedPath, OperatingSystem.IsWindows() ? "ffmpeg.exe" : "ffmpeg");
        }

        return trimmedPath;
    }
}

public sealed record ObsPreviewRequest(string InputUrl, string? FfmpegPath);

public sealed record ObsPreviewStatus(bool IsRunning, DateTimeOffset? StartedAt, string PreviewUrl, string? LastMessage);
