using System.Text.Json;
using System.Text.Json.Serialization;

namespace EmeraldLauncher;

/// <summary>
/// The suite layout, read from launcher.config.json next to the launcher executable.
///
/// Everything the launcher knows about the five services lives in that file rather than in this
/// code, because the install directory is chosen by the person running the installer and the data
/// directory differs between a workstation install and a portable one. Paths in the file use the
/// tokens {APP} (install root) and {DATA} (writable data root) plus ordinary %ENVVAR% expansion.
/// </summary>
public sealed class LauncherConfig
{
    public string DataDirectory { get; set; } = @"%PROGRAMDATA%\EmeraldDeltacastSuite";
    public List<ServiceDefinition> Services { get; set; } = new();

    /// <summary>
    /// The desktop applications this suite presents. Each one is a native window hosting a locally
    /// served UI, opened by re-running this executable with <c>--app &lt;id&gt;</c>.
    /// </summary>
    public List<AppDefinition> Apps { get; set; } = new();

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    public static LauncherConfig Load(string configPath, string appRoot)
    {
        var json = File.ReadAllText(configPath);
        var config = JsonSerializer.Deserialize<LauncherConfig>(json, JsonOptions)
                     ?? throw new InvalidDataException($"'{configPath}' did not contain a launcher configuration.");

        var dataRoot = Environment.ExpandEnvironmentVariables(config.DataDirectory);
        config.DataDirectory = dataRoot;

        foreach (var service in config.Services)
        {
            service.Executable = Expand(service.Executable, appRoot, dataRoot);
            service.Arguments = Expand(service.Arguments, appRoot, dataRoot);
            service.WorkingDirectory = Expand(service.WorkingDirectory, appRoot, dataRoot);
            service.HealthUrl = Expand(service.HealthUrl, appRoot, dataRoot);

            var expandedEnv = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in service.Environment)
            {
                // Keys beginning with "//" are the config file's own annotations — JSON has no
                // comment syntax the file can rely on, so notes are written as sibling keys. They
                // must not reach the child process as environment variables.
                if (pair.Key.StartsWith("//", StringComparison.Ordinal)) continue;
                expandedEnv[pair.Key] = Expand(pair.Value, appRoot, dataRoot);
            }
            service.Environment = expandedEnv;
        }

        foreach (var app in config.Apps)
        {
            app.Url = Expand(app.Url, appRoot, dataRoot);
            app.Icon = Expand(app.Icon, appRoot, dataRoot);
        }

        config.Services.Sort((a, b) => a.StartupOrder.CompareTo(b.StartupOrder));
        return config;
    }

    public static string Expand(string value, string appRoot, string dataRoot)
    {
        if (string.IsNullOrEmpty(value)) return value;
        return Environment.ExpandEnvironmentVariables(
            value.Replace("{APP}", appRoot, StringComparison.OrdinalIgnoreCase)
                 .Replace("{DATA}", dataRoot, StringComparison.OrdinalIgnoreCase));
    }
}

public sealed class ServiceDefinition
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public string Executable { get; set; } = "";
    public string Arguments { get; set; } = "";
    public string WorkingDirectory { get; set; } = "";

    /// <summary>URL polled to decide the service is actually up, not merely spawned. Optional.</summary>
    public string HealthUrl { get; set; } = "";

    /// <summary>TCP port the service listens on, shown in the UI. 0 when the service has none.</summary>
    public int Port { get; set; }

    /// <summary>Lower numbers start first; a service waits for its health check before the next starts.</summary>
    public int StartupOrder { get; set; } = 100;

    /// <summary>
    /// Seconds to wait for <see cref="HealthUrl"/> before giving up on this service. The Deltacast
    /// service needs the longest: it opens SDI channels and can sit through a signal-lock timeout.
    /// </summary>
    public int HealthTimeoutSeconds { get; set; } = 60;

    /// <summary>
    /// When true a crashed service is restarted automatically (up to a small cap) instead of just
    /// being reported as failed.
    /// </summary>
    public bool AutoRestart { get; set; } = true;

    /// <summary>
    /// Set false for a service whose absence should not block the rest of the suite — the Deltacast
    /// capture service on a machine with no SDI board, for example.
    /// </summary>
    public bool Required { get; set; } = true;

    public Dictionary<string, string> Environment { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

/// <summary>One of the suite's desktop applications: a window, a title, and the URL it displays.</summary>
public sealed class AppDefinition
{
    /// <summary>Passed on the command line as <c>--app &lt;id&gt;</c>; also names the WebView2 profile.</summary>
    public string Id { get; set; } = "";

    /// <summary>Window and taskbar title, and the label on the control panel's button.</summary>
    public string Title { get; set; } = "";

    /// <summary>Shorter label for the control panel button and tray menu; falls back to the title.</summary>
    public string Label { get; set; } = "";

    public string Url { get; set; } = "";

    /// <summary>Window icon. Relative names resolve against the launcher folder.</summary>
    public string Icon { get; set; } = "";

    public int Width { get; set; } = 1440;
    public int Height { get; set; } = 900;

    /// <summary>Start maximised — the sensible default for a full-screen broadcast UI.</summary>
    public bool Maximized { get; set; } = true;

    /// <summary>
    /// Seconds the window waits for <see cref="Url"/> to answer before it stops retrying and offers
    /// a Retry button. Covers the case of an app shortcut being used as the way into the suite,
    /// with the services still starting behind it.
    /// </summary>
    public int StartupTimeoutSeconds { get; set; } = 120;
}
