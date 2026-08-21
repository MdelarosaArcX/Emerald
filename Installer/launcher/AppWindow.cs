using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace EmeraldLauncher;

/// <summary>
/// A native desktop window for one of the suite's UIs.
///
/// Emerald and LiveEdit are Vue applications served over HTTP by the suite's own static hosts, but
/// an operator should not have to keep a browser open, hunt for the right tab, or see an address
/// bar and a set of bookmarks around a broadcast control surface. This hosts the same UI in an
/// ordinary application window with its own taskbar entry and icon — the page is identical, the
/// chrome is gone.
///
/// A window can be opened before the services are ready (someone double-clicks the desktop
/// shortcut on a cold machine), so it starts the suite if it is not already running and shows a
/// waiting screen until its URL answers.
/// </summary>
public sealed class AppWindow : Form
{
    private readonly AppDefinition _app;
    private readonly string _userDataFolder;
    private readonly string _windowStateFile;

    private readonly WebView2 _webView = new();
    private readonly Panel _splash = new();
    private readonly Label _splashTitle = new();
    private readonly Label _splashStatus = new();
    private readonly Button _retryButton = new();
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(4) };

    private CancellationTokenSource _waitCancellation = new();

    public AppWindow(AppDefinition app, string dataRoot)
    {
        _app = app;
        // WebView2 needs a writable profile folder, and Program Files is not one. Per-app so the two
        // windows keep independent local storage and do not fight over a single profile lock.
        _userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "EmeraldDeltacastSuite", "WebView2", string.IsNullOrWhiteSpace(app.Id) ? "app" : app.Id);
        _windowStateFile = Path.Combine(_userDataFolder, "window.json");
        Directory.CreateDirectory(_userDataFolder);

        BuildLayout();
        Load += async (_, _) => await StartAsync().ConfigureAwait(true);
    }

    private void BuildLayout()
    {
        Text = string.IsNullOrWhiteSpace(_app.Title) ? "Emerald Deltacast Suite" : _app.Title;
        Icon = AppIcon.Load(_app.Icon);
        MinimumSize = new Size(960, 600);
        Size = new Size(Math.Max(960, _app.Width), Math.Max(600, _app.Height));
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(17, 19, 20);
        RestoreWindowState();

        _webView.Dock = DockStyle.Fill;
        _webView.Visible = false;
        _webView.DefaultBackgroundColor = Color.FromArgb(17, 19, 20);
        Controls.Add(_webView);

        _splash.Dock = DockStyle.Fill;
        _splash.BackColor = Color.FromArgb(17, 19, 20);

        _splashTitle.Text = Text;
        _splashTitle.Font = new Font("Segoe UI Semibold", 18F);
        _splashTitle.ForeColor = Color.FromArgb(232, 240, 236);
        _splashTitle.AutoSize = true;
        _splashTitle.Location = new Point(48, 48);

        _splashStatus.Text = "Starting the suite...";
        _splashStatus.Font = new Font("Segoe UI", 10F);
        _splashStatus.ForeColor = Color.FromArgb(150, 160, 158);
        _splashStatus.AutoSize = true;
        _splashStatus.MaximumSize = new Size(720, 0);
        _splashStatus.Location = new Point(50, 92);

        _retryButton.Text = "Retry";
        _retryButton.AutoSize = true;
        _retryButton.Padding = new Padding(14, 6, 14, 6);
        _retryButton.Location = new Point(50, 140);
        _retryButton.Visible = false;
        _retryButton.Click += async (_, _) =>
        {
            _retryButton.Visible = false;
            await StartAsync().ConfigureAwait(true);
        };

        _splash.Controls.Add(_splashTitle);
        _splash.Controls.Add(_splashStatus);
        _splash.Controls.Add(_retryButton);
        Controls.Add(_splash);
        _splash.BringToFront();

        // An operator driving a monitor wall needs reload and full-screen without a browser menu.
        KeyPreview = true;
        KeyDown += OnKeyDown;
        FormClosing += (_, _) => SaveWindowState();
    }

    private async Task StartAsync()
    {
        _waitCancellation.Cancel();
        _waitCancellation = new CancellationTokenSource();
        var cancellationToken = _waitCancellation.Token;

        SetStatus("Contacting " + _app.Url + " ...");

        if (!await IsServiceUpAsync(cancellationToken).ConfigureAwait(true))
        {
            EnsureSuiteRunning();
            var deadline = DateTime.UtcNow.AddSeconds(_app.StartupTimeoutSeconds);
            while (DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
            {
                var remaining = (int)(deadline - DateTime.UtcNow).TotalSeconds;
                SetStatus("Waiting for the suite to finish starting... (" + remaining + "s)");
                await Task.Delay(1500, cancellationToken).ConfigureAwait(true);
                if (await IsServiceUpAsync(cancellationToken).ConfigureAwait(true)) break;
            }
        }

        if (!await IsServiceUpAsync(cancellationToken).ConfigureAwait(true))
        {
            SetStatus(_app.Title + " could not be reached at " + _app.Url + "." + Environment.NewLine +
                      "Open the Emerald Deltacast Suite control panel from the notification area or the Start menu " +
                      "to see which service failed, then try again.");
            _retryButton.Visible = true;
            return;
        }

        SetStatus("Loading...");
        CoreWebView2 core;
        try
        {
            core = await InitialiseWebViewAsync().ConfigureAwait(true);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            // The one component the installer cannot supply offline. Say so plainly rather than
            // showing the operator a COM error.
            SetStatus("The Microsoft Edge WebView2 runtime is not installed on this machine, so the " +
                      "desktop window cannot be shown." + Environment.NewLine + Environment.NewLine +
                      "Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and reopen " +
                      _app.Title + ", or open " + _app.Url + " in a browser in the meantime.");
            _retryButton.Visible = true;
            return;
        }
        catch (Exception ex)
        {
            SetStatus("Could not start the embedded browser: " + ex.Message);
            _retryButton.Visible = true;
            return;
        }

        core.Navigate(_app.Url);
    }

    private async Task<CoreWebView2> InitialiseWebViewAsync()
    {
        if (_webView.CoreWebView2 is not null) return _webView.CoreWebView2;

        // Autoplay: these UIs put a live video monitor on screen the moment they load, and WebView2
        // otherwise blocks playback until the operator clicks the page.
        var options = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
        var environment = await CoreWebView2Environment
            .CreateAsync(browserExecutableFolder: null, userDataFolder: _userDataFolder, options: options)
            .ConfigureAwait(true);

        await _webView.EnsureCoreWebView2Async(environment).ConfigureAwait(true);

        // EnsureCoreWebView2Async either populates CoreWebView2 or throws, so anything still null
        // here is a broken WebView2 install rather than a state worth handling further down.
        var core = _webView.CoreWebView2
                   ?? throw new InvalidOperationException("WebView2 initialised without a CoreWebView2 instance.");

        var settings = core.Settings;
        settings.AreDefaultContextMenusEnabled = false;   // no "View page source" on a control surface
        settings.IsStatusBarEnabled = false;
        settings.AreBrowserAcceleratorKeysEnabled = false; // Ctrl+P, Ctrl+F etc. belong to a browser
        settings.IsZoomControlEnabled = true;
        settings.AreDevToolsEnabled = true;                // F12 stays available for support

        // target="_blank" would otherwise open a bare WebView2 popup with no icon or title.
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) && IsOwnOrigin(uri))
            {
                core.Navigate(e.Uri);
            }
            else
            {
                // Anything genuinely external (documentation, a vendor page) belongs in the browser.
                try { Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true }); } catch { }
            }
        };

        core.DocumentTitleChanged += (_, _) =>
        {
            var documentTitle = core.DocumentTitle;
            Text = string.IsNullOrWhiteSpace(documentTitle) ? _app.Title : _app.Title + " - " + documentTitle;
        };

        // A backend restarting mid-session leaves a dead page; show why instead of Edge's error page.
        core.NavigationCompleted += (_, e) =>
        {
            if (e.IsSuccess)
            {
                _splash.Visible = false;
                _webView.Visible = true;
                return;
            }

            _webView.Visible = false;
            _splash.Visible = true;
            SetStatus("Lost the connection to " + _app.Url + " (" + e.WebErrorStatus + ")." +
                      Environment.NewLine + "The service may be restarting.");
            _retryButton.Visible = true;
        };

        return core;
    }

    private bool IsOwnOrigin(Uri uri)
    {
        return Uri.TryCreate(_app.Url, UriKind.Absolute, out var appUri) &&
               string.Equals(uri.Host, appUri.Host, StringComparison.OrdinalIgnoreCase) &&
               uri.Port == appUri.Port;
    }

    private async Task<bool> IsServiceUpAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var response = await _http.GetAsync(_app.Url, cancellationToken).ConfigureAwait(true);
            return (int)response.StatusCode < 500;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Starts the control panel if it is not already running, so an app shortcut works as the way
    /// into the suite on a cold machine. The launcher's own mutex is the test — creating it here and
    /// releasing it immediately is what tells us whether a copy already holds it, and avoids
    /// launching a second one that would only pop up an "already running" message box.
    /// </summary>
    private void EnsureSuiteRunning()
    {
        try
        {
            using var mutex = new Mutex(false, Program.SingleInstanceMutex, out _);
            var alreadyRunning = !mutex.WaitOne(TimeSpan.Zero, false);
            if (alreadyRunning) return;
            mutex.ReleaseMutex();
        }
        catch (AbandonedMutexException)
        {
            // A previous launcher died without releasing it; treat that as "not running".
        }
        catch
        {
            return;
        }

        try
        {
            SetStatus("Starting the Emerald Deltacast Suite services...");
            Process.Start(new ProcessStartInfo(Environment.ProcessPath!, "--minimized")
            {
                UseShellExecute = false,
                WorkingDirectory = AppContext.BaseDirectory,
            });
        }
        catch (Exception ex)
        {
            SetStatus("Could not start the suite automatically: " + ex.Message);
        }
    }

    private void SetStatus(string message)
    {
        _splash.Visible = true;
        _splash.BringToFront();
        _splashStatus.Text = message;
    }

    private void OnKeyDown(object? sender, KeyEventArgs e)
    {
        switch (e.KeyCode)
        {
            case Keys.F5:
                _webView.CoreWebView2?.Reload();
                e.Handled = true;
                break;
            case Keys.F11:
                ToggleFullScreen();
                e.Handled = true;
                break;
            case Keys.Escape when FormBorderStyle == FormBorderStyle.None:
                ToggleFullScreen();
                e.Handled = true;
                break;
        }
    }

    private void ToggleFullScreen()
    {
        if (FormBorderStyle == FormBorderStyle.None)
        {
            FormBorderStyle = FormBorderStyle.Sizable;
            WindowState = FormWindowState.Normal;
            WindowState = FormWindowState.Maximized;
        }
        else
        {
            WindowState = FormWindowState.Normal;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Maximized;
        }
    }

    private sealed class SavedWindowState
    {
        public int Width { get; set; }
        public int Height { get; set; }
        public int Left { get; set; }
        public int Top { get; set; }
        public bool Maximized { get; set; }
    }

    private void RestoreWindowState()
    {
        try
        {
            if (File.Exists(_windowStateFile))
            {
                var saved = JsonSerializer.Deserialize<SavedWindowState>(File.ReadAllText(_windowStateFile));
                if (saved is { Width: > 400, Height: > 300 })
                {
                    // Only restore a position that still lands on a connected screen — a monitor
                    // unplugged since the last run would otherwise open the window off-screen.
                    var bounds = new Rectangle(saved.Left, saved.Top, saved.Width, saved.Height);
                    if (Screen.AllScreens.Any(screen => screen.WorkingArea.IntersectsWith(bounds)))
                    {
                        StartPosition = FormStartPosition.Manual;
                        Bounds = bounds;
                    }
                    else
                    {
                        Size = new Size(saved.Width, saved.Height);
                    }

                    WindowState = saved.Maximized ? FormWindowState.Maximized : FormWindowState.Normal;
                    return;
                }
            }
        }
        catch
        {
            // A corrupt state file must never stop the window opening.
        }

        if (_app.Maximized) WindowState = FormWindowState.Maximized;
    }

    private void SaveWindowState()
    {
        try
        {
            var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            var state = new SavedWindowState
            {
                Width = bounds.Width,
                Height = bounds.Height,
                Left = bounds.Left,
                Top = bounds.Top,
                Maximized = WindowState == FormWindowState.Maximized,
            };
            File.WriteAllText(_windowStateFile, JsonSerializer.Serialize(state));
        }
        catch
        {
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _waitCancellation.Cancel();
            _waitCancellation.Dispose();
            _http.Dispose();
            _webView.Dispose();
        }
        base.Dispose(disposing);
    }
}
