using System.Diagnostics;
using System.Net.Http;
using System.Text;

namespace EmeraldLauncher;

public enum ServiceState
{
    Stopped,
    Starting,
    Running,
    Failed,
    Stopping,
}

/// <summary>
/// Owns one service process: starting it, tailing its output into a log file, polling its health
/// endpoint, restarting it if it dies unexpectedly, and stopping it cleanly.
/// </summary>
public sealed class ServiceSupervisor : IDisposable
{
    private const int MaxAutoRestarts = 3;

    private readonly ServiceDefinition _definition;
    private readonly ProcessJob _job;
    private readonly string _logPath;
    private readonly object _gate = new();
    private readonly Queue<string> _recentOutput = new();
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(4) };

    private Process? _process;
    private StreamWriter? _logWriter;
    private int _restartCount;
    private bool _stopRequested;
    private DateTime _startedAt;

    public ServiceSupervisor(ServiceDefinition definition, ProcessJob job, string logDirectory)
    {
        _definition = definition;
        _job = job;
        Directory.CreateDirectory(logDirectory);
        _logPath = Path.Combine(logDirectory, definition.Id + ".log");
    }

    public ServiceDefinition Definition => _definition;
    public string LogPath => _logPath;
    public ServiceState State { get; private set; } = ServiceState.Stopped;
    public string StatusDetail { get; private set; } = "";
    public int ProcessId => _process is { HasExited: false } ? _process.Id : 0;
    public TimeSpan Uptime => State == ServiceState.Running ? DateTime.Now - _startedAt : TimeSpan.Zero;

    /// <summary>Raised whenever state, output, or process identity changes, so the UI can refresh.</summary>
    public event Action<ServiceSupervisor>? Changed;

    /// <summary>Raised for each captured output line, so the log pane can stream it.</summary>
    public event Action<ServiceSupervisor, string>? OutputReceived;

    public string[] RecentOutput
    {
        get { lock (_gate) return _recentOutput.ToArray(); }
    }

    public async Task<bool> StartAsync(CancellationToken cancellationToken)
    {
        if (State is ServiceState.Running or ServiceState.Starting) return true;

        _stopRequested = false;
        SetState(ServiceState.Starting, "Launching...");

        if (!File.Exists(_definition.Executable))
        {
            SetState(ServiceState.Failed, "Executable not found: " + _definition.Executable);
            Append("[launcher] executable not found: " + _definition.Executable);
            return false;
        }

        try
        {
            StartProcess();
        }
        catch (Exception ex)
        {
            SetState(ServiceState.Failed, ex.Message);
            Append("[launcher] failed to start: " + ex.Message);
            return false;
        }

        if (string.IsNullOrWhiteSpace(_definition.HealthUrl))
        {
            // Nothing to poll, so treat "still alive a moment later" as started. A process that
            // fails on a bad config usually exits within the first second or two.
            await Task.Delay(1500, cancellationToken).ConfigureAwait(false);
            if (_process is { HasExited: false })
            {
                SetState(ServiceState.Running, "Running");
                return true;
            }
            SetState(ServiceState.Failed, "Exited immediately (exit code " + (_process?.ExitCode ?? -1) + ")");
            return false;
        }

        var deadline = DateTime.UtcNow.AddSeconds(_definition.HealthTimeoutSeconds);
        while (DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
        {
            if (_process is null || _process.HasExited)
            {
                SetState(ServiceState.Failed, "Exited during startup (exit code " + (_process?.ExitCode ?? -1) + ")");
                return false;
            }

            if (await IsHealthyAsync(cancellationToken).ConfigureAwait(false))
            {
                SetState(ServiceState.Running, "Running");
                return true;
            }

            SetState(ServiceState.Starting, "Waiting for " + _definition.HealthUrl);
            await Task.Delay(1000, cancellationToken).ConfigureAwait(false);
        }

        // The process is alive but never answered. Report it rather than pretending it started —
        // for a non-required service (no SDI board present) the caller carries on regardless.
        SetState(ServiceState.Failed, "Health check timed out after " + _definition.HealthTimeoutSeconds + "s");
        return false;
    }

    private void StartProcess()
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = _definition.Executable,
            Arguments = _definition.Arguments,
            WorkingDirectory = string.IsNullOrWhiteSpace(_definition.WorkingDirectory)
                ? Path.GetDirectoryName(_definition.Executable)!
                : _definition.WorkingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        foreach (var pair in _definition.Environment)
        {
            startInfo.Environment[pair.Key] = pair.Value;
        }

        Directory.CreateDirectory(startInfo.WorkingDirectory);

        // Fresh log per start, with the previous run kept as .log.1 — the usual reason anyone opens
        // these is "it died, what did it say", and that answer is in the run that just ended.
        RollLog();
        _logWriter = new StreamWriter(new FileStream(_logPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
        {
            AutoFlush = true,
        };

        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) Append(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) Append(e.Data); };
        process.Exited += OnProcessExited;

        Append("[launcher] starting " + _definition.Executable + " " + _definition.Arguments);
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        _job.Add(process.Handle);
        _process = process;
        _startedAt = DateTime.Now;
        Changed?.Invoke(this);
    }

    private void OnProcessExited(object? sender, EventArgs e)
    {
        if (_stopRequested)
        {
            SetState(ServiceState.Stopped, "Stopped");
            return;
        }

        var exitCode = -1;
        try { exitCode = _process?.ExitCode ?? -1; } catch { /* already reaped */ }
        Append("[launcher] process exited with code " + exitCode);

        if (_definition.AutoRestart && _restartCount < MaxAutoRestarts)
        {
            _restartCount++;
            SetState(ServiceState.Starting, "Crashed (exit " + exitCode + ") - restarting " + _restartCount + "/" + MaxAutoRestarts);
            _ = Task.Run(async () =>
            {
                await Task.Delay(2000).ConfigureAwait(false);
                if (!_stopRequested) await StartAsync(CancellationToken.None).ConfigureAwait(false);
            });
            return;
        }

        SetState(ServiceState.Failed, "Exited with code " + exitCode);
    }

    public async Task StopAsync()
    {
        _stopRequested = true;
        _restartCount = 0;

        var process = _process;
        if (process is null || process.HasExited)
        {
            SetState(ServiceState.Stopped, "Stopped");
            CloseLog();
            return;
        }

        SetState(ServiceState.Stopping, "Stopping...");
        try
        {
            // Kill the whole tree: node and the capture service both leave ffmpeg/mediamtx children
            // holding the media ports open otherwise.
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(new CancellationTokenSource(TimeSpan.FromSeconds(15)).Token)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Append("[launcher] stop failed: " + ex.Message);
        }

        SetState(ServiceState.Stopped, "Stopped");
        CloseLog();
    }

    public async Task<bool> IsHealthyAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_definition.HealthUrl)) return _process is { HasExited: false };
        try
        {
            using var response = await _http.GetAsync(_definition.HealthUrl, cancellationToken).ConfigureAwait(false);
            // Any answer at all proves the listener is up; a 404 from a route that moved still means
            // the service is serving, and treating it as down would strand a healthy suite.
            return (int)response.StatusCode < 500;
        }
        catch
        {
            return false;
        }
    }

    private void RollLog()
    {
        try
        {
            if (!File.Exists(_logPath)) return;
            var previous = _logPath + ".1";
            File.Delete(previous);
            File.Move(_logPath, previous);
        }
        catch
        {
            // A locked log file must not stop the service from starting.
        }
    }

    private void CloseLog()
    {
        try { _logWriter?.Dispose(); } catch { }
        _logWriter = null;
    }

    private void Append(string line)
    {
        var stamped = DateTime.Now.ToString("HH:mm:ss") + "  " + line;
        lock (_gate)
        {
            _recentOutput.Enqueue(stamped);
            while (_recentOutput.Count > 400) _recentOutput.Dequeue();
            try { _logWriter?.WriteLine(stamped); } catch { }
        }
        OutputReceived?.Invoke(this, stamped);
    }

    private void SetState(ServiceState state, string detail)
    {
        State = state;
        StatusDetail = detail;
        Changed?.Invoke(this);
    }

    public void Dispose()
    {
        CloseLog();
        _http.Dispose();
        try { _process?.Dispose(); } catch { }
    }
}
