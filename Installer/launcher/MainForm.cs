using System.Diagnostics;

namespace EmeraldLauncher;

/// <summary>
/// The suite's control panel: one row per service with live status, buttons to start/stop the whole
/// suite or a single service, a streaming log pane, and shortcuts that open the two web UIs.
/// Closing the window hides it to the tray so the services keep running; quitting from the tray (or
/// the Quit button) stops every service first.
/// </summary>
public sealed class MainForm : Form
{
    private readonly LauncherConfig _config;
    private readonly List<ServiceSupervisor> _supervisors;
    private readonly ProcessJob _job;

    private readonly ListView _serviceList = new();
    private readonly TextBox _logView = new();
    private readonly Label _summaryLabel = new();
    private readonly Button _startAllButton = new();
    private readonly Button _stopAllButton = new();
    private readonly Button _restartButton = new();
    private readonly Button _openLogsButton = new();
    private readonly Button _settingsButton = new();
    private readonly string _appRoot;
    private readonly string _configPath;
    private readonly NotifyIcon _trayIcon = new();
    private readonly System.Windows.Forms.Timer _refreshTimer = new();

    private CancellationTokenSource _startCancellation = new();
    private bool _quitting;
    private string _selectedServiceId = "";

    private readonly System.Collections.Concurrent.ConcurrentQueue<string> _pendingLogLines = new();
    private readonly System.Windows.Forms.Timer _logDrainTimer = new();

    /// <summary>Lines held for the log pane between drains; older ones are dropped past this.</summary>
    private const int MaxQueuedLogLines = 2000;

    /// <summary>Lines moved into the pane per tick, so a busy service cannot monopolise the UI.</summary>
    private const int MaxLinesPerDrain = 200;

    /// <summary>How much scrollback the pane keeps; the full log is on disk regardless.</summary>
    private const int MaxLogPaneLines = 500;

    public MainForm(
        LauncherConfig config,
        List<ServiceSupervisor> supervisors,
        ProcessJob job,
        bool startMinimized,
        string appRoot,
        string configPath)
    {
        _config = config;
        _appRoot = appRoot;
        _configPath = configPath;
        _supervisors = supervisors;
        _job = job;

        BuildLayout();
        WireSupervisors();

        Load += async (_, _) =>
        {
            if (startMinimized) HideToTray();
            await StartAllAsync().ConfigureAwait(true);
        };
    }

    private void BuildLayout()
    {
        Text = "Emerald Deltacast Suite";
        MinimumSize = new Size(900, 560);
        Size = new Size(1040, 680);
        StartPosition = FormStartPosition.CenterScreen;
        Icon = AppIcon.Load();
        Font = new Font("Segoe UI", 9F);

        var header = new Panel { Dock = DockStyle.Top, Height = 96, Padding = new Padding(16, 12, 16, 8) };

        var title = new Label
        {
            Text = "Emerald Deltacast Suite",
            Font = new Font("Segoe UI Semibold", 15F),
            AutoSize = true,
            Location = new Point(16, 12),
        };
        _summaryLabel.Text = "Starting services...";
        _summaryLabel.AutoSize = true;
        _summaryLabel.Location = new Point(18, 44);
        _summaryLabel.ForeColor = SystemColors.GrayText;
        header.Controls.Add(title);
        header.Controls.Add(_summaryLabel);

        var linkPanel = new FlowLayoutPanel
        {
            Dock = DockStyle.Right,
            FlowDirection = FlowDirection.RightToLeft,
            AutoSize = true,
            WrapContents = false,
            Padding = new Padding(0, 24, 0, 0),
        };
        foreach (var app in _config.Apps)
        {
            var button = new Button
            {
                Text = "Open " + (string.IsNullOrWhiteSpace(app.Label) ? app.Title : app.Label),
                AutoSize = true,
                Height = 32,
                Padding = new Padding(10, 4, 10, 4),
            };
            var appId = app.Id;
            button.Click += (_, _) => OpenApp(appId);
            linkPanel.Controls.Add(button);
        }
        header.Controls.Add(linkPanel);
        Controls.Add(header);

        _serviceList.Dock = DockStyle.Fill;
        _serviceList.View = View.Details;
        _serviceList.FullRowSelect = true;
        _serviceList.MultiSelect = false;
        _serviceList.HideSelection = false;
        _serviceList.Columns.Add("Service", 230);
        _serviceList.Columns.Add("Status", 110);
        _serviceList.Columns.Add("Detail", 330);
        _serviceList.Columns.Add("Port", 70, HorizontalAlignment.Right);
        _serviceList.Columns.Add("PID", 70, HorizontalAlignment.Right);
        _serviceList.Columns.Add("Uptime", 90, HorizontalAlignment.Right);
        _serviceList.SelectedIndexChanged += (_, _) =>
        {
            if (_serviceList.SelectedItems.Count == 0) return;
            _selectedServiceId = (string)_serviceList.SelectedItems[0].Tag!;
            ShowSelectedLog();
        };

        var listContainer = new Panel { Dock = DockStyle.Top, Height = 190, Padding = new Padding(16, 0, 16, 8) };
        listContainer.Controls.Add(_serviceList);
        Controls.Add(listContainer);

        foreach (var supervisor in _supervisors)
        {
            var item = new ListViewItem(supervisor.Definition.Name) { Tag = supervisor.Definition.Id };
            item.SubItems.Add("Stopped");
            item.SubItems.Add("");
            item.SubItems.Add(supervisor.Definition.Port > 0 ? supervisor.Definition.Port.ToString() : "-");
            item.SubItems.Add("-");
            item.SubItems.Add("-");
            _serviceList.Items.Add(item);
        }
        if (_serviceList.Items.Count > 0)
        {
            _serviceList.Items[0].Selected = true;
            _selectedServiceId = _supervisors[0].Definition.Id;
        }

        _logView.Dock = DockStyle.Fill;
        _logView.Multiline = true;
        _logView.ReadOnly = true;
        _logView.ScrollBars = ScrollBars.Vertical;
        _logView.WordWrap = false;
        _logView.BackColor = Color.FromArgb(24, 26, 27);
        _logView.ForeColor = Color.FromArgb(220, 223, 228);
        _logView.Font = new Font("Consolas", 9F);
        _logView.BorderStyle = BorderStyle.FixedSingle;

        var logContainer = new Panel { Dock = DockStyle.Fill, Padding = new Padding(16, 0, 16, 8) };
        logContainer.Controls.Add(_logView);
        Controls.Add(logContainer);
        logContainer.BringToFront();

        var buttonPanel = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 56,
            Padding = new Padding(16, 10, 16, 10),
            FlowDirection = FlowDirection.LeftToRight,
        };
        ConfigureButton(_startAllButton, "Start All", async (_, _) => await StartAllAsync().ConfigureAwait(true));
        ConfigureButton(_stopAllButton, "Stop All", async (_, _) => await StopAllAsync().ConfigureAwait(true));
        ConfigureButton(_restartButton, "Restart Selected", async (_, _) => await RestartSelectedAsync().ConfigureAwait(true));
        ConfigureButton(_settingsButton, "Settings...", (_, _) => OpenSettings());
        ConfigureButton(_openLogsButton, "Open Log Folder", (_, _) => OpenLogFolder());
        buttonPanel.Controls.Add(_startAllButton);
        buttonPanel.Controls.Add(_stopAllButton);
        buttonPanel.Controls.Add(_restartButton);
        buttonPanel.Controls.Add(_settingsButton);
        buttonPanel.Controls.Add(_openLogsButton);

        var quitButton = new Button { Text = "Quit Suite", AutoSize = true, Height = 32, Padding = new Padding(12, 4, 12, 4) };
        quitButton.Click += async (_, _) => await QuitAsync().ConfigureAwait(true);
        buttonPanel.Controls.Add(quitButton);
        Controls.Add(buttonPanel);

        _trayIcon.Icon = AppIcon.Load();
        _trayIcon.Text = "Emerald Deltacast Suite";
        _trayIcon.Visible = true;
        _trayIcon.DoubleClick += (_, _) => ShowFromTray();

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Control Panel", null, (_, _) => ShowFromTray());
        menu.Items.Add(new ToolStripSeparator());
        foreach (var app in _config.Apps)
        {
            var appId = app.Id;
            var label = string.IsNullOrWhiteSpace(app.Label) ? app.Title : app.Label;
            menu.Items.Add("Open " + label, null, (_, _) => OpenApp(appId));
        }
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit Suite", null, async (_, _) => await QuitAsync().ConfigureAwait(true));
        _trayIcon.ContextMenuStrip = menu;

        _refreshTimer.Interval = 1000;
        _refreshTimer.Tick += (_, _) => RefreshRows();
        _refreshTimer.Start();

        _logDrainTimer.Interval = 250;
        _logDrainTimer.Tick += (_, _) => DrainLogQueue();
        _logDrainTimer.Start();

        FormClosing += OnFormClosing;
    }

    private static void ConfigureButton(Button button, string text, EventHandler handler)
    {
        button.Text = text;
        button.AutoSize = true;
        button.Height = 32;
        button.Padding = new Padding(12, 4, 12, 4);
        button.Margin = new Padding(0, 0, 8, 0);
        button.Click += handler;
    }

    private void WireSupervisors()
    {
        foreach (var supervisor in _supervisors)
        {
            supervisor.Changed += _ => BeginInvoke(RefreshRows);

            // Queue only — never marshal per line. A chatty service (the capture service logs an
            // HTTP line for every status poll the Emerald backend makes, several times a second)
            // otherwise floods the UI thread with thousands of BeginInvoke callbacks, and because
            // the startup loop resumes on that same thread between services, the tail of the
            // startup sequence simply stops running. The drain timer below does the work in
            // batches instead.
            supervisor.OutputReceived += (source, line) =>
            {
                if (source.Definition.Id != _selectedServiceId) return;
                _pendingLogLines.Enqueue(line);
                while (_pendingLogLines.Count > MaxQueuedLogLines) _pendingLogLines.TryDequeue(out _);
            };
        }
    }

    /// <summary>
    /// Moves whatever the selected service has logged since the last tick into the log pane in one
    /// append. Bounded per tick so a service in a tight error loop cannot monopolise the UI thread.
    /// </summary>
    private void DrainLogQueue()
    {
        if (_pendingLogLines.IsEmpty) return;

        var batch = new List<string>();
        while (batch.Count < MaxLinesPerDrain && _pendingLogLines.TryDequeue(out var line))
        {
            batch.Add(line);
        }
        if (batch.Count == 0) return;

        // Trim first, then append once: repeatedly round-tripping TextBox.Lines through a string[]
        // is what made the old per-line path so expensive.
        var existing = _logView.Lines;
        if (existing.Length + batch.Count > MaxLogPaneLines)
        {
            var keep = Math.Max(0, MaxLogPaneLines - batch.Count);
            _logView.Lines = existing.Skip(Math.Max(0, existing.Length - keep)).ToArray();
        }

        _logView.AppendText(string.Join(Environment.NewLine, batch) + Environment.NewLine);
        ScrollLogToEnd();
    }

    private async Task StartAllAsync()
    {
        _startAllButton.Enabled = false;
        _startCancellation.Dispose();
        _startCancellation = new CancellationTokenSource();

        // Sequential and in startupOrder: the frontends proxy to their backends, and the Emerald
        // backend brings up MediaMTX, so starting everything at once produces a burst of connection
        // errors in the logs even when the outcome is fine.
        //
        // Deliberately off the UI thread. Bringing the suite up takes tens of seconds, and if the
        // sequence resumed on the UI thread between services then anything holding that thread —
        // a flood of log output, a modal dialog, a slow repaint — would stall the services still
        // waiting their turn. Only the notification below comes back to the UI thread.
        var token = _startCancellation.Token;
        try
        {
            await Task.Run(async () =>
            {
                foreach (var supervisor in _supervisors)
                {
                    var started = await supervisor.StartAsync(token).ConfigureAwait(false);
                    if (started || !supervisor.Definition.Required) continue;

                    var name = supervisor.Definition.Name;
                    BeginInvoke(() => _trayIcon.ShowBalloonTip(
                        5000,
                        "Emerald Deltacast Suite",
                        name + " did not start. See its log for details.",
                        ToolTipIcon.Warning));
                }
            }, token).ConfigureAwait(true);
        }
        catch (OperationCanceledException)
        {
            // Stop All (or Quit) was pressed while the suite was still coming up — an ordinary
            // outcome, not an error worth surfacing.
        }

        _startAllButton.Enabled = true;
        RefreshRows();
    }

    private async Task StopAllAsync()
    {
        _stopAllButton.Enabled = false;
        _startCancellation.Cancel();
        // Reverse order so the frontends stop before the backends they proxy to.
        foreach (var supervisor in Enumerable.Reverse(_supervisors))
        {
            await supervisor.StopAsync().ConfigureAwait(true);
        }
        _stopAllButton.Enabled = true;
        RefreshRows();
    }

    private async Task RestartSelectedAsync()
    {
        var supervisor = _supervisors.FirstOrDefault(s => s.Definition.Id == _selectedServiceId);
        if (supervisor is null) return;

        _restartButton.Enabled = false;
        await supervisor.StopAsync().ConfigureAwait(true);
        await supervisor.StartAsync(CancellationToken.None).ConfigureAwait(true);
        _restartButton.Enabled = true;
    }

    private void RefreshRows()
    {
        for (var i = 0; i < _supervisors.Count && i < _serviceList.Items.Count; i++)
        {
            var supervisor = _supervisors[i];
            var item = _serviceList.Items[i];
            item.SubItems[1].Text = supervisor.State.ToString();
            item.SubItems[2].Text = supervisor.StatusDetail;
            item.SubItems[4].Text = supervisor.ProcessId > 0 ? supervisor.ProcessId.ToString() : "-";
            item.SubItems[5].Text = supervisor.State == ServiceState.Running
                ? FormatUptime(supervisor.Uptime)
                : "-";
            item.ForeColor = supervisor.State switch
            {
                ServiceState.Running => Color.FromArgb(21, 128, 61),
                ServiceState.Failed => Color.FromArgb(185, 28, 28),
                ServiceState.Starting or ServiceState.Stopping => Color.FromArgb(161, 98, 7),
                _ => SystemColors.ControlText,
            };
        }

        var running = _supervisors.Count(s => s.State == ServiceState.Running);
        var failed = _supervisors.Count(s => s.State == ServiceState.Failed);
        _summaryLabel.Text = running + " of " + _supervisors.Count + " services running"
                             + (failed > 0 ? "  -  " + failed + " failed" : "");
        _trayIcon.Text = "Emerald Deltacast Suite - " + running + "/" + _supervisors.Count + " running";
    }

    private static string FormatUptime(TimeSpan uptime) =>
        uptime.TotalHours >= 1
            ? ((int)uptime.TotalHours) + "h " + uptime.Minutes + "m"
            : uptime.Minutes + "m " + uptime.Seconds + "s";

    private void ShowSelectedLog()
    {
        var supervisor = _supervisors.FirstOrDefault(s => s.Definition.Id == _selectedServiceId);
        if (supervisor is null) return;

        // Anything queued belongs to the service that was selected a moment ago.
        while (_pendingLogLines.TryDequeue(out _)) { }

        var recent = supervisor.RecentOutput;
        _logView.Lines = recent.Length > MaxLogPaneLines
            ? recent.Skip(recent.Length - MaxLogPaneLines).ToArray()
            : recent;
        ScrollLogToEnd();
    }

    private void ScrollLogToEnd()
    {
        _logView.SelectionStart = _logView.TextLength;
        _logView.ScrollToCaret();
    }

    /// <summary>
    /// Opens the settings editor for the capture service's appsettings.json and each service's
    /// environment. Both live in the install directory, which the launcher reads once at startup and
    /// passes to each service as it spawns it — so a saved change needs a restart, which the editor
    /// offers and this carries out.
    /// </summary>
    private void OpenSettings()
    {
        using var settings = new SettingsForm(_appRoot, _configPath);
        settings.ShowDialog(this);

        if (settings.RestartRequested)
        {
            _ = RestartSuiteAsync();
            return;
        }

        if (settings.ChangesSaved)
        {
            _trayIcon.ShowBalloonTip(5000, "Emerald Deltacast Suite",
                "Settings saved. Restart the suite to apply them.", ToolTipIcon.Info);
        }
    }

    /// <summary>
    /// Stops everything and starts a fresh launcher, which is what it takes to pick up an edited
    /// configuration: the file is read once at startup, and each service receives its environment
    /// only when it is spawned. The replacement waits on this process's own single-instance mutex
    /// being released, so it cannot race the copy it is replacing.
    /// </summary>
    private async Task RestartSuiteAsync()
    {
        if (_quitting) return;
        _quitting = true;
        _refreshTimer.Stop();
        _logDrainTimer.Stop();
        _summaryLabel.Text = "Restarting the suite...";

        CloseAppWindows();
        await StopAllAsync().ConfigureAwait(true);

        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        _job.Dispose();

        try
        {
            Process.Start(new ProcessStartInfo(Environment.ProcessPath!, "--restarted")
            {
                UseShellExecute = false,
                WorkingDirectory = AppContext.BaseDirectory,
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(this,
                "The suite stopped but could not start itself again:\n\n" + ex.Message +
                "\n\nStart it from the Start menu.",
                "Emerald Deltacast Suite", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        Application.Exit();
    }

    private void OpenLogFolder()
    {
        var logDirectory = Path.Combine(_config.DataDirectory, "logs");
        Directory.CreateDirectory(logDirectory);
        Process.Start(new ProcessStartInfo("explorer.exe", "\"" + logDirectory + "\"") { UseShellExecute = true });
    }

    /// <summary>
    /// Opens one of the suite's UIs as a desktop window by re-running this executable in app mode,
    /// rather than handing the URL to the default browser. A second click on an app that is already
    /// open raises the existing window instead of starting another.
    /// </summary>
    private void OpenApp(string appId)
    {
        try
        {
            Process.Start(new ProcessStartInfo(Environment.ProcessPath!, "--app " + appId)
            {
                UseShellExecute = false,
                WorkingDirectory = AppContext.BaseDirectory,
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Could not open " + appId + ":\n" + ex.Message, "Emerald Deltacast Suite",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    /// <summary>
    /// Closes any open Emerald/LiveEdit windows before the services stop. They are separate
    /// processes (not part of the services' job object), so without this the operator is left
    /// looking at two windows that have just lost their backend.
    /// </summary>
    private void CloseAppWindows()
    {
        try
        {
            var current = Process.GetCurrentProcess();
            foreach (var process in Process.GetProcessesByName(current.ProcessName))
            {
                if (process.Id == current.Id || process.MainWindowHandle == IntPtr.Zero) continue;
                process.CloseMainWindow();
            }
        }
        catch
        {
            // Never let tidying up windows block the shutdown of the services themselves.
        }
    }

    private void HideToTray()
    {
        Hide();
        ShowInTaskbar = false;
    }

    private void ShowFromTray()
    {
        Show();
        ShowInTaskbar = true;
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_quitting) return;

        // A stray window close must not take a live broadcast off air, so the X button only hides.
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            HideToTray();
            _trayIcon.ShowBalloonTip(3000, "Emerald Deltacast Suite",
                "Still running. Use the tray icon to reopen or quit.", ToolTipIcon.Info);
            return;
        }

        // Windows shutting the session down: stop the tree rather than leaving orphaned ffmpeg.
        e.Cancel = true;
        _ = QuitAsync();
    }

    private async Task QuitAsync()
    {
        if (_quitting) return;
        _quitting = true;
        _refreshTimer.Stop();
        _logDrainTimer.Stop();
        _summaryLabel.Text = "Stopping services...";

        CloseAppWindows();
        await StopAllAsync().ConfigureAwait(true);

        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        _job.Dispose();
        Application.Exit();
    }
}
