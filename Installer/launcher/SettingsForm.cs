using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace EmeraldLauncher;

/// <summary>
/// The suite's settings editor: one screen for the configuration of all five services, so an
/// operator can change a port, a storage path or an SDI channel without hunting through Program
/// Files for the right file and without a JSON editor.
///
/// What it edits is what actually takes effect, which is not quite the set of files a developer
/// would expect from the source tree:
///
///   * The capture service really does read <c>appsettings.json</c> from the install folder, so
///     that file is edited directly.
///   * The two Node backends are configured by the <c>environment</c> block the launcher passes
///     them, not by a <c>.env</c> file. In a development checkout dotenv reads <c>backend\.env</c>;
///     the installed backends run from a read-only Program Files with their working directory
///     elsewhere, and every value they need is supplied by <c>launcher.config.json</c>. Editing a
///     <c>.env</c> there would be editing a file nothing reads — worse, values the launcher sets
///     would silently win over it, since dotenv never overwrites an existing variable. So the
///     environment block is presented here in <c>.env</c> syntax and written back to the one file
///     that is actually consulted.
///   * The frontends are compiled bundles. Their <c>VITE_*</c> values are baked in by Vite at build
///     time and cannot be changed after installation at all; those are shown read-only, with what
///     is genuinely adjustable at runtime (port, bind address, proxy target) editable above.
///
/// Values are read from and written to the raw JSON, never the expanded in-memory configuration,
/// so the <c>{APP}</c> and <c>{DATA}</c> tokens survive a round trip instead of being flattened
/// into absolute paths the first time somebody opens this window.
/// </summary>
public sealed class SettingsForm : Form
{
    private readonly string _appRoot;
    private readonly string _configPath;
    private readonly BuildInfo? _buildInfo;

    private readonly ListBox _sectionList = new();
    private readonly Label _sectionTitle = new();
    private readonly Label _sectionDescription = new();
    private readonly TextBox _editor = new();
    private readonly Label _readOnlyNote = new();
    private readonly Label _statusLabel = new();
    private readonly Button _saveButton = new();
    private readonly Button _revertButton = new();
    private readonly Button _openFolderButton = new();

    private readonly List<SettingsSection> _sections = new();
    private SettingsSection? _current;
    private bool _dirty;
    private bool _loading;

    /// <summary>True when something was saved, so the caller can offer to restart the suite.</summary>
    public bool ChangesSaved { get; private set; }

    public SettingsForm(string appRoot, string configPath)
    {
        _appRoot = appRoot;
        _configPath = configPath;
        _buildInfo = BuildInfo.Load(appRoot);

        BuildSections();
        BuildLayout();

        if (_sectionList.Items.Count > 0) _sectionList.SelectedIndex = 0;
    }

    // ---------------------------------------------------------------------------------------
    // Sections
    // ---------------------------------------------------------------------------------------

    private enum SectionKind { JsonFile, ServiceEnvironment }

    private sealed class SettingsSection
    {
        public string Title { get; init; } = "";
        public string Description { get; init; } = "";
        public SectionKind Kind { get; init; }

        /// <summary>For <see cref="SectionKind.JsonFile"/>: the file edited verbatim.</summary>
        public string FilePath { get; init; } = "";

        /// <summary>For <see cref="SectionKind.ServiceEnvironment"/>: which service's block.</summary>
        public string ServiceId { get; init; } = "";

        /// <summary>Shown under the editor — things that cannot be changed from here.</summary>
        public string ReadOnlyNote { get; init; } = "";

        public override string ToString() => Title;
    }

    private void BuildSections()
    {
        _sections.Add(new SettingsSection
        {
            Title = "Deltacast Capture",
            Kind = SectionKind.JsonFile,
            FilePath = Path.Combine(_appRoot, "DeltacastCaptureService", "appsettings.json"),
            Description =
                "appsettings.json for the SDI capture service — board and channel indexes, pixel format, " +
                "resolution, frame rate, edit-capture segmenting and the on-air preview. Edited as JSON; " +
                "it is checked for syntax before saving.",
            ReadOnlyNote =
                "Any value here can also be overridden per-run from the service's environment block using " +
                ".NET's double-underscore syntax, e.g. Capture__Simulate or Http__Port.",
        });

        _sections.Add(new SettingsSection
        {
            Title = "Emerald — Backend",
            Kind = SectionKind.ServiceEnvironment,
            ServiceId = "emerald-backend",
            Description =
                "Environment for the Emerald backend — the installed equivalent of backend\\.env. Storage " +
                "paths, the database, FFmpeg and MediaMTX locations, the RTMP and timecode settings.",
            ReadOnlyNote =
                "{APP} is the install folder, {DATA} the writable data folder; %VARIABLES% also expand. " +
                "Lines beginning with # are notes and are not passed to the service.",
        });

        _sections.Add(new SettingsSection
        {
            Title = "Emerald — Frontend",
            Kind = SectionKind.ServiceEnvironment,
            ServiceId = "emerald-frontend",
            Description =
                "Environment for the host that serves the built Emerald UI: the port it listens on, the " +
                "address it binds, and which paths it proxies through to the backend.",
            ReadOnlyNote = BuildFrontendNote("Emerald"),
        });

        _sections.Add(new SettingsSection
        {
            Title = "LiveEdit — Backend",
            Kind = SectionKind.ServiceEnvironment,
            ServiceId = "liveedit-backend",
            Description =
                "Environment for the LiveEdit backend — the installed equivalent of LiveEdit\\backend\\.env. " +
                "Its port, the browser origin it accepts, and where it reads Emerald's media from.",
            ReadOnlyNote =
                "LiveEdit writes its proxy/render cache relative to its working directory, so that must stay " +
                "somewhere writable — see the workingDirectory entry in launcher.config.json.",
        });

        _sections.Add(new SettingsSection
        {
            Title = "LiveEdit — Frontend",
            Kind = SectionKind.ServiceEnvironment,
            ServiceId = "liveedit-frontend",
            Description =
                "Environment for the host that serves the built LiveEdit UI: its port, bind address and the " +
                "paths proxied to the LiveEdit backend, including the socket.io websocket.",
            ReadOnlyNote = BuildFrontendNote("LiveEdit"),
        });
    }

    /// <summary>
    /// The frontends' own <c>VITE_*</c> settings are compiled into the JavaScript bundle by Vite and
    /// are genuinely unchangeable after installation. Saying so — and showing the values this build
    /// was made with — is more use than an editable box that would do nothing.
    /// </summary>
    private string BuildFrontendNote(string which)
    {
        var note = new StringBuilder();
        note.Append("The UI's own VITE_* values are compiled into the bundle at build time and cannot be ");
        note.Append("changed here; changing them needs a rebuild of the installer.");

        if (which == "LiveEdit" && _buildInfo is not null)
        {
            note.AppendLine();
            note.Append("This build: VITE_EMERALD_API_BASE_URL=").Append(_buildInfo.EmeraldApiBaseUrl);
            note.Append("   VITE_EMERALD_MONITOR_BASE_URL=").Append(_buildInfo.EmeraldMonitorBaseUrl);
        }
        else if (which == "Emerald")
        {
            note.AppendLine();
            note.Append("The Emerald UI calls its backend on relative paths only, so it has no baked-in addresses.");
        }

        return note.ToString();
    }

    // ---------------------------------------------------------------------------------------
    // Layout
    // ---------------------------------------------------------------------------------------

    private void BuildLayout()
    {
        Text = "Emerald Deltacast Suite — Settings";
        Icon = AppIcon.Load();
        MinimumSize = new Size(900, 600);
        Size = new Size(1080, 740);
        StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Segoe UI", 9F);

        var header = new Panel { Dock = DockStyle.Top, Height = 60, Padding = new Padding(16, 12, 16, 4) };
        var heading = new Label
        {
            Text = "Application settings",
            Font = new Font("Segoe UI Semibold", 13F),
            AutoSize = true,
            Location = new Point(16, 12),
        };
        var subheading = new Label
        {
            Text = "Changes take effect when the affected service restarts.",
            ForeColor = SystemColors.GrayText,
            AutoSize = true,
            Location = new Point(18, 36),
        };
        header.Controls.Add(heading);
        header.Controls.Add(subheading);
        Controls.Add(header);

        var buttonPanel = new Panel { Dock = DockStyle.Bottom, Height = 56, Padding = new Padding(16, 10, 16, 10) };

        _statusLabel.AutoSize = true;
        _statusLabel.Location = new Point(18, 20);
        _statusLabel.ForeColor = SystemColors.GrayText;
        buttonPanel.Controls.Add(_statusLabel);

        var actions = new FlowLayoutPanel
        {
            Dock = DockStyle.Right,
            FlowDirection = FlowDirection.RightToLeft,
            AutoSize = true,
            WrapContents = false,
        };

        ConfigureButton(_saveButton, "Save", async (_, _) => await SaveAsync().ConfigureAwait(true));
        ConfigureButton(_revertButton, "Revert", (_, _) => LoadSection(_current));
        ConfigureButton(_openFolderButton, "Show File", (_, _) => ShowFile());
        var closeButton = new Button { Text = "Close", AutoSize = true, Height = 30, Padding = new Padding(12, 4, 12, 4), Margin = new Padding(8, 0, 0, 0) };
        closeButton.Click += (_, _) => Close();

        actions.Controls.Add(closeButton);
        actions.Controls.Add(_saveButton);
        actions.Controls.Add(_revertButton);
        actions.Controls.Add(_openFolderButton);
        buttonPanel.Controls.Add(actions);
        Controls.Add(buttonPanel);

        var body = new Panel { Dock = DockStyle.Fill, Padding = new Padding(16, 4, 16, 4) };

        _sectionList.Dock = DockStyle.Left;
        _sectionList.Width = 210;
        _sectionList.IntegralHeight = false;
        _sectionList.SelectedIndexChanged += (_, _) =>
        {
            if (_sectionList.SelectedItem is SettingsSection section) SelectSection(section);
        };
        foreach (var section in _sections) _sectionList.Items.Add(section);

        var right = new Panel { Dock = DockStyle.Fill, Padding = new Padding(12, 0, 0, 0) };

        _sectionTitle.Dock = DockStyle.Top;
        _sectionTitle.Height = 24;
        _sectionTitle.Font = new Font("Segoe UI Semibold", 10.5F);

        _sectionDescription.Dock = DockStyle.Top;
        _sectionDescription.Height = 56;
        _sectionDescription.ForeColor = SystemColors.GrayText;

        _readOnlyNote.Dock = DockStyle.Bottom;
        _readOnlyNote.Height = 52;
        _readOnlyNote.ForeColor = SystemColors.GrayText;
        _readOnlyNote.Padding = new Padding(0, 6, 0, 0);

        _editor.Dock = DockStyle.Fill;
        _editor.Multiline = true;
        _editor.ScrollBars = ScrollBars.Both;
        _editor.WordWrap = false;
        _editor.AcceptsTab = true;
        _editor.Font = new Font("Consolas", 10F);
        _editor.BackColor = Color.FromArgb(24, 26, 27);
        _editor.ForeColor = Color.FromArgb(220, 223, 228);
        _editor.BorderStyle = BorderStyle.FixedSingle;
        _editor.TextChanged += (_, _) =>
        {
            if (_loading) return;
            _dirty = true;
            UpdateStatus("Unsaved changes", warn: true);
        };

        right.Controls.Add(_editor);
        right.Controls.Add(_readOnlyNote);
        right.Controls.Add(_sectionDescription);
        right.Controls.Add(_sectionTitle);

        body.Controls.Add(right);
        body.Controls.Add(_sectionList);
        Controls.Add(body);
        body.BringToFront();

        FormClosing += OnFormClosing;
    }

    private static void ConfigureButton(Button button, string text, EventHandler handler)
    {
        button.Text = text;
        button.AutoSize = true;
        button.Height = 30;
        button.Padding = new Padding(12, 4, 12, 4);
        button.Margin = new Padding(8, 0, 0, 0);
        button.Click += handler;
    }

    // ---------------------------------------------------------------------------------------
    // Loading
    // ---------------------------------------------------------------------------------------

    private void SelectSection(SettingsSection section)
    {
        if (_dirty && _current is not null && _current != section)
        {
            var answer = MessageBox.Show(
                this,
                $"Save your changes to {_current.Title} before switching?",
                "Emerald Deltacast Suite",
                MessageBoxButtons.YesNoCancel,
                MessageBoxIcon.Question);

            if (answer == DialogResult.Cancel)
            {
                _sectionList.SelectedItem = _current;
                return;
            }
            if (answer == DialogResult.Yes && !Save())
            {
                _sectionList.SelectedItem = _current;
                return;
            }
        }

        LoadSection(section);
    }

    private void LoadSection(SettingsSection? section)
    {
        if (section is null) return;

        _loading = true;
        try
        {
            _current = section;
            _sectionTitle.Text = section.Title;
            _sectionDescription.Text = section.Description;
            _readOnlyNote.Text = section.ReadOnlyNote;

            _editor.Text = section.Kind == SectionKind.JsonFile
                ? ReadJsonFile(section.FilePath)
                : ReadServiceEnvironment(section.ServiceId);

            _editor.SelectionStart = 0;
            _dirty = false;
            UpdateStatus(section.Kind == SectionKind.JsonFile
                ? section.FilePath
                : $"{_configPath}  →  services[{section.ServiceId}].environment");
        }
        catch (Exception ex)
        {
            _editor.Text = "";
            UpdateStatus("Could not read this section: " + ex.Message, warn: true);
        }
        finally
        {
            _loading = false;
        }
    }

    private static string ReadJsonFile(string path)
    {
        if (!File.Exists(path)) throw new FileNotFoundException($"'{path}' does not exist.");
        return File.ReadAllText(path).Replace("\r\n", "\n").Replace("\n", Environment.NewLine);
    }

    /// <summary>
    /// Renders a service's environment block as .env-style text. The configuration file has no
    /// comment syntax of its own, so its "//" annotation keys are surfaced here as # comment lines —
    /// the guidance is worth more next to the value it describes than hidden in the JSON.
    /// </summary>
    private string ReadServiceEnvironment(string serviceId)
    {
        var environment = GetEnvironmentNode(LoadConfigRoot(), serviceId)
                          ?? throw new InvalidOperationException($"No environment block for service '{serviceId}'.");

        var text = new StringBuilder();
        foreach (var entry in environment)
        {
            var value = entry.Value?.ToString() ?? "";
            if (entry.Key.StartsWith("//", StringComparison.Ordinal))
            {
                var subject = entry.Key[2..];
                text.Append("# ");
                if (subject.Length > 0) text.Append(subject).Append(": ");
                text.AppendLine(value);
            }
            else
            {
                text.Append(entry.Key).Append('=').AppendLine(value);
            }
        }
        return text.ToString();
    }

    private JsonNode LoadConfigRoot()
    {
        var options = new JsonNodeOptions { PropertyNameCaseInsensitive = false };
        var documentOptions = new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
        return JsonNode.Parse(File.ReadAllText(_configPath), options, documentOptions)
               ?? throw new InvalidDataException($"'{_configPath}' is empty.");
    }

    private static JsonObject? GetEnvironmentNode(JsonNode root, string serviceId)
    {
        if (root["services"] is not JsonArray services) return null;
        foreach (var service in services)
        {
            if (service is not JsonObject serviceObject) continue;
            if (!string.Equals(serviceObject["id"]?.ToString(), serviceId, StringComparison.OrdinalIgnoreCase)) continue;
            return serviceObject["environment"] as JsonObject;
        }
        return null;
    }

    // ---------------------------------------------------------------------------------------
    // Saving
    // ---------------------------------------------------------------------------------------

    private async Task SaveAsync()
    {
        if (!Save()) return;

        // The launcher reads the configuration once, at startup, and each service receives its
        // environment when it is spawned — so a saved change is inert until things restart.
        var answer = MessageBox.Show(
            this,
            "Settings saved.\n\nThe suite must restart for the change to take effect. Restart it now?",
            "Emerald Deltacast Suite",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Information);

        if (answer == DialogResult.Yes)
        {
            RestartRequested = true;
            await Task.Yield();
            Close();
        }
    }

    /// <summary>Set when the operator asked to restart the suite after saving.</summary>
    public bool RestartRequested { get; private set; }

    private bool Save()
    {
        if (_current is null) return false;

        try
        {
            var content = _editor.Text;
            string targetPath;
            string newContent;

            if (_current.Kind == SectionKind.JsonFile)
            {
                // Parse before writing: a JSON syntax error here stops the capture service from
                // starting at all, and finding that out from a failed startup is a poor trade for
                // a check that costs nothing.
                try
                {
                    using var _ = JsonDocument.Parse(content, new JsonDocumentOptions
                    {
                        CommentHandling = JsonCommentHandling.Skip,
                        AllowTrailingCommas = true,
                    });
                }
                catch (JsonException ex)
                {
                    MessageBox.Show(this, "This is not valid JSON, so it has not been saved:\n\n" + ex.Message,
                        "Emerald Deltacast Suite", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return false;
                }

                targetPath = _current.FilePath;
                newContent = content;
            }
            else
            {
                if (!TryParseEnvironment(content, out var parsed, out var parseError))
                {
                    MessageBox.Show(this, parseError, "Emerald Deltacast Suite",
                        MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return false;
                }

                var root = LoadConfigRoot();
                var environment = GetEnvironmentNode(root, _current.ServiceId)
                                  ?? throw new InvalidOperationException($"No environment block for '{_current.ServiceId}'.");

                // Rebuild the block: keep the "//" annotations exactly as they were (they are
                // documentation, not settings, and are not editable from here), then apply the
                // operator's keys in the order they wrote them.
                var rebuilt = new JsonObject();
                foreach (var entry in environment)
                {
                    if (entry.Key.StartsWith("//", StringComparison.Ordinal))
                    {
                        rebuilt[entry.Key] = entry.Value?.DeepClone();
                    }
                }
                foreach (var pair in parsed)
                {
                    rebuilt[pair.Key] = JsonValue.Create(pair.Value);
                }

                ReplaceEnvironmentNode(root, _current.ServiceId, rebuilt);

                targetPath = _configPath;
                newContent = root.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
            }

            if (!WriteWithElevationFallback(targetPath, newContent, out var writeError))
            {
                MessageBox.Show(this, "Could not save:\n\n" + writeError, "Emerald Deltacast Suite",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }

            _dirty = false;
            ChangesSaved = true;
            UpdateStatus("Saved to " + targetPath);
            if (_current.Kind == SectionKind.ServiceEnvironment) LoadSection(_current);
            return true;
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Could not save:\n\n" + ex.Message, "Emerald Deltacast Suite",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
    }

    private static void ReplaceEnvironmentNode(JsonNode root, string serviceId, JsonObject replacement)
    {
        if (root["services"] is not JsonArray services) return;
        foreach (var service in services)
        {
            if (service is not JsonObject serviceObject) continue;
            if (!string.Equals(serviceObject["id"]?.ToString(), serviceId, StringComparison.OrdinalIgnoreCase)) continue;
            serviceObject["environment"] = replacement;
            return;
        }
    }

    private static bool TryParseEnvironment(string text, out Dictionary<string, string> parsed, out string error)
    {
        parsed = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        error = "";

        var lineNumber = 0;
        foreach (var rawLine in text.Replace("\r\n", "\n").Split('\n'))
        {
            lineNumber++;
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;

            var separator = line.IndexOf('=');
            if (separator <= 0)
            {
                error = $"Line {lineNumber} is not a NAME=value setting or a # comment:\n\n{rawLine}";
                return false;
            }

            var key = line[..separator].Trim();
            if (key.Length == 0 || key.Any(char.IsWhiteSpace))
            {
                error = $"Line {lineNumber} has an invalid setting name '{key}'. Names cannot contain spaces.";
                return false;
            }

            // Trailing whitespace in a path is invisible and breaks it, so trim the value; a value
            // that genuinely needs it can be quoted, and quotes are stripped here.
            var value = line[(separator + 1)..].Trim();
            if (value.Length >= 2 && value[0] == '"' && value[^1] == '"') value = value[1..^1];

            parsed[key] = value;
        }

        return true;
    }

    /// <summary>
    /// Writes the file, elevating only if the direct write is refused. The install directory is
    /// under Program Files, so an operator running as a standard user cannot write there — but
    /// prompting for elevation every time would be wrong too, since a portable or per-user install
    /// needs no such thing.
    /// </summary>
    private bool WriteWithElevationFallback(string path, string content, out string error)
    {
        error = "";
        try
        {
            BackupFile(path);
            File.WriteAllText(path, content);
            return true;
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            // Fall through to the elevated path below.
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }

        var staging = Path.Combine(Path.GetTempPath(), "emerald-settings-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            File.WriteAllText(staging, content);

            var startInfo = new ProcessStartInfo(Environment.ProcessPath!)
            {
                // Quoted: both paths routinely contain spaces ("C:\Program Files\...").
                Arguments = $"--apply-settings \"{staging}\" \"{path}\"",
                UseShellExecute = true,
                Verb = "runas",
            };

            using var process = Process.Start(startInfo);
            if (process is null)
            {
                error = "The elevation prompt could not be started.";
                return false;
            }

            process.WaitForExit(60_000);
            if (!process.HasExited)
            {
                error = "Timed out waiting for the elevated save to finish.";
                return false;
            }
            if (process.ExitCode != 0)
            {
                error = $"The elevated save failed (exit code {process.ExitCode}).";
                return false;
            }

            return true;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // The operator dismissed the UAC prompt.
            error = "Saving to this location needs administrator rights, and the elevation prompt was declined.";
            return false;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
        finally
        {
            try { File.Delete(staging); } catch { }
        }
    }

    /// <summary>Keeps one previous copy — the fastest way back from a bad edit.</summary>
    internal static void BackupFile(string path)
    {
        try
        {
            if (File.Exists(path)) File.Copy(path, path + ".bak", overwrite: true);
        }
        catch
        {
            // A backup that cannot be written must not stop the save itself.
        }
    }

    private void ShowFile()
    {
        var path = _current?.Kind == SectionKind.JsonFile ? _current.FilePath : _configPath;
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", "/select,\"" + path + "\"") { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            UpdateStatus("Could not open the folder: " + ex.Message, warn: true);
        }
    }

    private void UpdateStatus(string message, bool warn = false)
    {
        _statusLabel.Text = message;
        _statusLabel.ForeColor = warn ? Color.FromArgb(161, 98, 7) : SystemColors.GrayText;
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (!_dirty) return;

        var answer = MessageBox.Show(
            this,
            "You have unsaved changes. Save them before closing?",
            "Emerald Deltacast Suite",
            MessageBoxButtons.YesNoCancel,
            MessageBoxIcon.Question);

        if (answer == DialogResult.Cancel) { e.Cancel = true; return; }
        if (answer == DialogResult.Yes && !Save()) e.Cancel = true;
    }
}

/// <summary>What the build recorded about itself, used to show unchangeable build-time settings.</summary>
internal sealed class BuildInfo
{
    public string Version { get; private set; } = "";
    public string EmeraldApiBaseUrl { get; private set; } = "";
    public string EmeraldMonitorBaseUrl { get; private set; } = "";

    public static BuildInfo? Load(string appRoot)
    {
        try
        {
            var path = Path.Combine(appRoot, "build-info.json");
            if (!File.Exists(path)) return null;

            var root = JsonNode.Parse(File.ReadAllText(path));
            if (root is null) return null;

            return new BuildInfo
            {
                Version = root["version"]?.ToString() ?? "",
                EmeraldApiBaseUrl = root["liveEdit"]?["emeraldApiBaseUrl"]?.ToString() ?? "",
                EmeraldMonitorBaseUrl = root["liveEdit"]?["emeraldMonitorBaseUrl"]?.ToString() ?? "",
            };
        }
        catch
        {
            return null;
        }
    }
}
