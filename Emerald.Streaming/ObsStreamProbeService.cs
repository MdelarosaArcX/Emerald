using System.Diagnostics;
using System.Globalization;
using System.Text.Json;

namespace Emerald.Streaming;

public static class ObsStreamProbeService
{
    public static async Task<ObsStreamProbeResult> ProbeAsync(ObsStreamProbeRequest request, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.InputUrl))
        {
            throw new InvalidOperationException("OBS recording URL is required before stream stats can be probed.");
        }

        var ffprobePath = NormalizeFfprobePath(request.FfmpegPath);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(8));

        var startInfo = new ProcessStartInfo
        {
            FileName = ffprobePath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };

        AddArguments(startInfo, request.InputUrl.Trim());

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException($"Unable to start ffprobe at '{ffprobePath}'.");

        var outputTask = process.StandardOutput.ReadToEndAsync(timeout.Token);
        var errorTask = process.StandardError.ReadToEndAsync(timeout.Token);

        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            throw new InvalidOperationException("ffprobe timed out while reading the OBS stream. Make sure OBS is streaming and the URL is reachable.");
        }

        var output = await outputTask;
        var error = await errorTask;

        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(error) ? "ffprobe could not read the stream." : error.Trim());
        }

        return ParseResult(output);
    }

    private static void AddArguments(ProcessStartInfo startInfo, string inputUrl)
    {
        startInfo.ArgumentList.Add("-v");
        startInfo.ArgumentList.Add("error");
        startInfo.ArgumentList.Add("-select_streams");
        startInfo.ArgumentList.Add("v:0");
        startInfo.ArgumentList.Add("-show_entries");
        startInfo.ArgumentList.Add("stream=codec_name,width,height,avg_frame_rate,r_frame_rate,bit_rate:format=bit_rate");
        startInfo.ArgumentList.Add("-of");
        startInfo.ArgumentList.Add("json");
        startInfo.ArgumentList.Add(inputUrl);
    }

    private static ObsStreamProbeResult ParseResult(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        var stream = root.TryGetProperty("streams", out var streams) && streams.GetArrayLength() > 0
            ? streams[0]
            : default;

        var codec = GetString(stream, "codec_name");
        var width = GetInt(stream, "width");
        var height = GetInt(stream, "height");
        var fps = ParseFrameRate(GetString(stream, "avg_frame_rate")) ?? ParseFrameRate(GetString(stream, "r_frame_rate"));
        var streamBitrate = GetLong(stream, "bit_rate");
        var formatBitrate = root.TryGetProperty("format", out var format) ? GetLong(format, "bit_rate") : null;
        var bitrate = streamBitrate ?? formatBitrate;

        return new ObsStreamProbeResult(
            codec,
            width,
            height,
            fps,
            bitrate,
            FormatBitrate(bitrate),
            FormatResolution(width, height));
    }

    private static string NormalizeFfprobePath(string? configuredPath)
    {
        if (string.IsNullOrWhiteSpace(configuredPath))
        {
            return "ffprobe";
        }

        var trimmedPath = configuredPath.Trim().Trim('"');

        if (Directory.Exists(trimmedPath))
        {
            return Path.Combine(trimmedPath, OperatingSystem.IsWindows() ? "ffprobe.exe" : "ffprobe");
        }

        var fileName = Path.GetFileName(trimmedPath);
        if (fileName.StartsWith("ffmpeg", StringComparison.OrdinalIgnoreCase))
        {
            var directory = Path.GetDirectoryName(trimmedPath);
            return string.IsNullOrWhiteSpace(directory)
                ? (OperatingSystem.IsWindows() ? "ffprobe.exe" : "ffprobe")
                : Path.Combine(directory, OperatingSystem.IsWindows() ? "ffprobe.exe" : "ffprobe");
        }

        return trimmedPath;
    }

    private static string? GetString(JsonElement element, string propertyName)
    {
        return element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(propertyName, out var property)
            && property.ValueKind == JsonValueKind.String
                ? property.GetString()
                : null;
    }

    private static int? GetInt(JsonElement element, string propertyName)
    {
        return element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(propertyName, out var property)
            && property.TryGetInt32(out var value)
                ? value
                : null;
    }

    private static long? GetLong(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(propertyName, out var property))
        {
            return null;
        }

        if (property.ValueKind == JsonValueKind.Number && property.TryGetInt64(out var numberValue))
        {
            return numberValue;
        }

        return property.ValueKind == JsonValueKind.String
            && long.TryParse(property.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var stringValue)
                ? stringValue
                : null;
    }

    private static double? ParseFrameRate(string? frameRate)
    {
        if (string.IsNullOrWhiteSpace(frameRate) || frameRate == "0/0")
        {
            return null;
        }

        var parts = frameRate.Split('/');
        if (parts.Length == 2
            && double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var numerator)
            && double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var denominator)
            && denominator > 0)
        {
            return numerator / denominator;
        }

        return double.TryParse(frameRate, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : null;
    }

    private static string FormatBitrate(long? bitrate)
    {
        if (bitrate is null)
        {
            return "Not reported";
        }

        return bitrate >= 1_000_000
            ? $"{bitrate.Value / 1_000_000d:0.##} Mbps"
            : $"{bitrate.Value / 1_000d:0.##} Kbps";
    }

    private static string FormatResolution(int? width, int? height)
    {
        if (width is null || height is null)
        {
            return "Not reported";
        }

        var quality = height switch
        {
            >= 2160 => "2160p",
            >= 1440 => "1440p",
            >= 1080 => "1080p",
            >= 720 => "720p",
            >= 480 => "480p",
            _ => $"{height}p"
        };

        return $"{width} x {height} ({quality})";
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Best-effort cleanup after timeout.
        }
    }
}

public sealed record ObsStreamProbeRequest(string InputUrl, string? FfmpegPath);

public sealed record ObsStreamProbeResult(
    string? Codec,
    int? Width,
    int? Height,
    double? Fps,
    long? Bitrate,
    string BitrateText,
    string ResolutionText);
