using System.Diagnostics;

namespace Emerald.Streaming;

public sealed class ObsRecordingService : IDisposable
{
    private readonly object gate = new();
    private readonly string recordingsPath;
    private Process? process;

    public ObsRecordingService(string recordingsPath)
    {
        this.recordingsPath = recordingsPath;
    }

    public ObsRecordingStatus Status { get; private set; } = new(false, null, null, null, 120, "mp4", null);

    public ObsRecordingStatus Start(ObsRecordingRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.InputUrl))
        {
            throw new InvalidOperationException("OBS recording URL is required.");
        }

        lock (gate)
        {
            if (IsProcessRunning())
            {
                return Status;
            }

            var segmentSeconds = Math.Clamp(request.SegmentSeconds ?? 120, 10, 3600);
            var container = NormalizeContainer(request.Container);
            var ffmpegPath = NormalizeFfmpegPath(request.FfmpegPath);
            var outputPattern = Path.Combine(recordingsPath, $"obs-%Y%m%d-%H%M%S.{container.Extension}");

            var startInfo = new ProcessStartInfo
            {
                FileName = ffmpegPath,
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                CreateNoWindow = true
            };

            AddArguments(startInfo, request.InputUrl.Trim(), segmentSeconds, container.Format, outputPattern);

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
                Status = Status with { IsRecording = false, LastMessage = Status.LastMessage ?? "FFmpeg stopped." };
            };

            try
            {
                if (!ffmpeg.Start())
                {
                    throw new InvalidOperationException("Unable to start FFmpeg.");
                }
            }
            catch (Exception exception)
            {
                ffmpeg.Dispose();
                process = null;
                Status = Status with { IsRecording = false, LastMessage = exception.Message };
                throw new InvalidOperationException($"Unable to start FFmpeg at '{ffmpegPath}'. Use the full path to ffmpeg.exe or a folder that contains ffmpeg.exe.", exception);
            }

            process = ffmpeg;

            try
            {
                process.BeginErrorReadLine();
                process.BeginOutputReadLine();
            }
            catch (InvalidOperationException)
            {
                // Some process failures can exit before async stream readers attach.
            }

            Status = new ObsRecordingStatus(
                true,
                DateTimeOffset.UtcNow,
                request.InputUrl.Trim(),
                outputPattern,
                segmentSeconds,
                container.Extension,
                null);

            return Status;
        }
    }

    public ObsRecordingStatus Stop()
    {
        lock (gate)
        {
            if (process is null)
            {
                Status = Status with { IsRecording = false };
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
            Status = Status with { IsRecording = false, LastMessage = "Recording stopped." };
            return Status;
        }
    }

    public void Dispose()
    {
        Stop();
    }

    private static void AddArguments(ProcessStartInfo startInfo, string inputUrl, int segmentSeconds, string segmentFormat, string outputPattern)
    {
        startInfo.ArgumentList.Add("-hide_banner");
        startInfo.ArgumentList.Add("-loglevel");
        startInfo.ArgumentList.Add("warning");
        startInfo.ArgumentList.Add("-i");
        startInfo.ArgumentList.Add(inputUrl);
        startInfo.ArgumentList.Add("-map");
        startInfo.ArgumentList.Add("0");
        startInfo.ArgumentList.Add("-c");
        startInfo.ArgumentList.Add("copy");
        startInfo.ArgumentList.Add("-f");
        startInfo.ArgumentList.Add("segment");
        startInfo.ArgumentList.Add("-segment_time");
        startInfo.ArgumentList.Add(segmentSeconds.ToString());
        startInfo.ArgumentList.Add("-reset_timestamps");
        startInfo.ArgumentList.Add("1");
        startInfo.ArgumentList.Add("-strftime");
        startInfo.ArgumentList.Add("1");
        startInfo.ArgumentList.Add("-segment_format");
        startInfo.ArgumentList.Add(segmentFormat);
        startInfo.ArgumentList.Add(outputPattern);
    }

    private static RecordingContainer NormalizeContainer(string? container)
    {
        return container?.Trim().ToLowerInvariant() switch
        {
            "mkv" or "matroska" => new RecordingContainer("mkv", "matroska"),
            "ts" or "mpegts" => new RecordingContainer("ts", "mpegts"),
            _ => new RecordingContainer("mp4", "mp4")
        };
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
            Status = Status with { IsRecording = false };
            return false;
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

    private sealed record RecordingContainer(string Extension, string Format);
}

public sealed record ObsRecordingRequest(
    string InputUrl,
    int? SegmentSeconds,
    string? Container,
    string? FfmpegPath);

public sealed record ObsRecordingStatus(
    bool IsRecording,
    DateTimeOffset? StartedAt,
    string? InputUrl,
    string? OutputPattern,
    int SegmentSeconds,
    string Container,
    string? LastMessage);
