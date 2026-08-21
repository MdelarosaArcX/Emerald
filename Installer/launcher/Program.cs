using System.Diagnostics;

namespace EmeraldLauncher;

internal static class Program
{
    /// <summary>Name of the mutex that keeps a second launcher from fighting over the same ports.</summary>
    internal const string SingleInstanceMutex = @"Global\EmeraldDeltacastSuiteLauncher";

    /// <summary>
    /// One executable, three modes. Run with no arguments it is the control panel that supervises
    /// the five services; run as <c>--app emerald</c> or <c>--app liveedit</c> it is that
    /// application's desktop window. Sharing a binary rather than shipping a separate app shell
    /// avoids carrying a second copy of the self-contained .NET runtime (~140 MB) in the package.
    /// </summary>
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        // The launcher lives in {APP}\Launcher, so the install root is one level up. BaseDirectory
        // (not Assembly.Location) because it stays correct however the app is published.
        var launcherDirectory = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        var appRoot = Path.GetDirectoryName(launcherDirectory)!;
        var configPath = Path.Combine(appRoot, "config", "launcher.config.json");

        LauncherConfig config;
        try
        {
            config = LauncherConfig.Load(configPath, appRoot);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Could not read the suite configuration at:\n" + configPath + "\n\n" + ex.Message +
                "\n\nReinstall Emerald Deltacast Suite to restore it.",
                "Emerald Deltacast Suite", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        var requestedApp = ReadAppArgument(args);
        if (requestedApp is not null)
        {
            RunAppWindow(config, requestedApp);
            return;
        }

        RunControlPanel(config, args);
    }

    /// <summary>Reads <c>--app &lt;id&gt;</c> (or <c>--app=&lt;id&gt;</c>) from the command line.</summary>
    private static string? ReadAppArgument(string[] args)
    {
        for (var i = 0; i < args.Length; i++)
        {
            var argument = args[i];
            if (argument.StartsWith("--app=", StringComparison.OrdinalIgnoreCase) ||
                argument.StartsWith("/app=", StringComparison.OrdinalIgnoreCase))
            {
                return argument[(argument.IndexOf('=') + 1)..].Trim();
            }

            if ((argument.Equals("--app", StringComparison.OrdinalIgnoreCase) ||
                 argument.Equals("/app", StringComparison.OrdinalIgnoreCase)) && i + 1 < args.Length)
            {
                return args[i + 1].Trim();
            }
        }
        return null;
    }

    private static void RunAppWindow(LauncherConfig config, string appId)
    {
        var app = config.Apps.FirstOrDefault(a => a.Id.Equals(appId, StringComparison.OrdinalIgnoreCase));
        if (app is null)
        {
            var known = config.Apps.Count > 0
                ? string.Join(", ", config.Apps.Select(a => a.Id))
                : "(none configured)";
            MessageBox.Show(
                "There is no application called '" + appId + "' in the suite configuration.\n\n" +
                "Applications defined: " + known,
                "Emerald Deltacast Suite", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        // Two windows of the same app would fight over one WebView2 profile folder, so the second
        // launch hands focus to the first instead of opening a duplicate.
        using var appInstance = new Mutex(true, @"Global\EmeraldDeltacastSuiteApp_" + app.Id, out var isOnlyInstance);
        if (!isOnlyInstance)
        {
            NativeWindowActivator.ActivateExistingWindow(app.Title);
            return;
        }

        using var window = new AppWindow(app, config.DataDirectory);
        Application.Run(window);
    }

    private static void RunControlPanel(LauncherConfig config, string[] args)
    {
        using var singleInstance = new Mutex(true, SingleInstanceMutex, out var isOnlyInstance);
        if (!isOnlyInstance)
        {
            MessageBox.Show(
                "Emerald Deltacast Suite is already running. Use its tray icon to reopen the control panel.",
                "Emerald Deltacast Suite", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        try
        {
            PrepareDataDirectories(config.DataDirectory);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Could not create the data folder at:\n" + config.DataDirectory + "\n\n" + ex.Message,
                "Emerald Deltacast Suite", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        var job = new ProcessJob();
        var logDirectory = Path.Combine(config.DataDirectory, "logs");
        var supervisors = config.Services
            .Select(definition => new ServiceSupervisor(definition, job, logDirectory))
            .ToList();

        var startMinimized = args.Any(a =>
            a.Equals("--minimized", StringComparison.OrdinalIgnoreCase) ||
            a.Equals("/minimized", StringComparison.OrdinalIgnoreCase));

        using var form = new MainForm(config, supervisors, job, startMinimized);
        Application.Run(form);

        foreach (var supervisor in supervisors) supervisor.Dispose();
        job.Dispose();
    }

    /// <summary>
    /// Creates the writable tree the services expect. They run from Program Files, which is
    /// read-only for a standard user, so recordings, exports, the SQLite database and the logs all
    /// live under ProgramData and are passed in by environment variable.
    /// </summary>
    private static void PrepareDataDirectories(string dataRoot)
    {
        foreach (var relative in new[]
                 {
                     "", "logs", "Recordings", "Exports", "EditCaptures", "db",
                     Path.Combine("LiveEdit", "projects"),
                     Path.Combine("LiveEdit", "proxies"),
                     Path.Combine("LiveEdit", "renders"),
                 })
        {
            Directory.CreateDirectory(Path.Combine(dataRoot, relative));
        }
    }
}

/// <summary>
/// Loads one of the bundled icons by file name, falling back to the launcher's own icon and then to
/// the shell default. Each application has its own icon so the two windows are distinguishable in
/// the taskbar and Alt-Tab.
/// </summary>
internal static class AppIcon
{
    private static readonly Dictionary<string, Icon> Cache = new(StringComparer.OrdinalIgnoreCase);

    public static Icon Load(string? iconFileName = null)
    {
        var name = string.IsNullOrWhiteSpace(iconFileName) ? "emerald.ico" : iconFileName;
        if (Cache.TryGetValue(name, out var cached)) return cached;

        Icon icon;
        try
        {
            // A bare file name resolves next to the executable; a full path is used as given.
            var path = Path.IsPathRooted(name) ? name : Path.Combine(AppContext.BaseDirectory, name);
            if (!File.Exists(path)) path = Path.Combine(AppContext.BaseDirectory, "emerald.ico");

            icon = File.Exists(path)
                ? new Icon(path)
                : Icon.ExtractAssociatedIcon(Process.GetCurrentProcess().MainModule!.FileName!) ?? SystemIcons.Application;
        }
        catch
        {
            icon = SystemIcons.Application;
        }

        Cache[name] = icon;
        return icon;
    }
}

/// <summary>
/// Brings an already-open application window to the front when its shortcut is double-clicked a
/// second time — the behaviour any single-instance desktop app is expected to have.
/// </summary>
internal static class NativeWindowActivator
{
    public static void ActivateExistingWindow(string windowTitle)
    {
        try
        {
            var current = Process.GetCurrentProcess();
            foreach (var process in Process.GetProcessesByName(current.ProcessName))
            {
                if (process.Id == current.Id || process.MainWindowHandle == IntPtr.Zero) continue;
                // The window title gains a " - <page>" suffix from the hosted document's own title.
                if (!process.MainWindowTitle.StartsWith(windowTitle, StringComparison.OrdinalIgnoreCase)) continue;

                ShowWindow(process.MainWindowHandle, SW_RESTORE);
                SetForegroundWindow(process.MainWindowHandle);
                return;
            }
        }
        catch
        {
            // Failing to raise the existing window is not worth an error dialog.
        }
    }

    private const int SW_RESTORE = 9;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
}
