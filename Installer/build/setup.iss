; =============================================================================================
;  Emerald Deltacast Suite - Inno Setup script
;
;  Compiled by Installer\build\build-installer.ps1, which passes the payload location and version
;  in as defines. Building this file directly requires the staging tree to exist already:
;      ISCC.exe /DAppVersion=1.0.0 /DStageDir=..\stage /DOutputDir=.. setup.iss
; =============================================================================================

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\stage"
#endif
#ifndef OutputDir
  #define OutputDir ".."
#endif

#define AppName "Emerald Deltacast Suite"
#define AppPublisher "Emerald Deltacast"
#define LauncherExe "EmeraldLauncher.exe"
#define DataDirName "EmeraldDeltacastSuite"

[Setup]
AppId={{8F3C6C21-4E2B-4B67-9E0C-6D2F1A7C55D3}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
UninstallDisplayIcon={app}\Launcher\{#LauncherExe}
UninstallDisplayName={#AppName} {#AppVersion}
OutputDir={#OutputDir}
OutputBaseFilename=EmeraldDeltacastSuite-Setup-{#AppVersion}
SetupIconFile={#SourcePath}\..\launcher\emerald.ico
WizardStyle=modern
; The payload is ~1.7 GB and most of its bulk is already-compressed executables (Node, the two
; .NET runtimes, FFmpeg's DLLs), which lzma2/max spends a long time on for very little extra
; ratio. /normal keeps the build to a few minutes instead of tens of them.
Compression=lzma2/normal
SolidCompression=yes
; The payload carries its own Node, .NET and FFmpeg builds, all x64.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Installs into Program Files and adds firewall rules, both of which need elevation.
PrivilegesRequired=admin
; Matches the launcher's own single-instance mutex, so an upgrade over a running suite prompts to
; close it instead of failing halfway through with locked files.
AppMutex=Global\EmeraldDeltacastSuiteLauncher
CloseApplications=yes
RestartApplications=no
DisableDirPage=no
DisableProgramGroupPage=yes
LicenseFile={#SourcePath}\..\docs\LICENSE-NOTICES.txt
MinVersion=10.0
DirExistsWarning=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create &desktop shortcuts for Emerald Capture and LiveEdit"; GroupDescription: "Shortcuts:"
Name: "startupicon"; Description: "Start the suite automatically when I sign in"; GroupDescription: "Startup:"; Flags: unchecked
Name: "firewall"; Description: "Allow other machines on this network to reach the Emerald and LiveEdit web UIs"; GroupDescription: "Network:"; Flags: unchecked

[Dirs]
; The services run from Program Files, which is read-only for a standard user, so everything they
; write lives here. Created by setup (not first run) so the permissions are right for any operator
; account that later signs in, not just the one that happened to run the suite first.
Name: "{commonappdata}\{#DataDirName}"; Permissions: users-modify
Name: "{commonappdata}\{#DataDirName}\logs"; Permissions: users-modify
Name: "{commonappdata}\{#DataDirName}\Recordings"; Permissions: users-modify
Name: "{commonappdata}\{#DataDirName}\Exports"; Permissions: users-modify
Name: "{commonappdata}\{#DataDirName}\EditCaptures"; Permissions: users-modify
Name: "{commonappdata}\{#DataDirName}\db"; Permissions: users-modify
Name: "{commonappdata}\{#DataDirName}\Emerald"; Permissions: users-modify
Name: "{commonappdata}\{#DataDirName}\DeltacastCaptureService"; Permissions: users-modify
Name: "{commonappdata}\{#DataDirName}\LiveEdit"; Permissions: users-modify

[Files]
; Everything except the configuration file, which is handled below so a hand-edited copy survives
; an upgrade. The leading backslash is required: an Excludes pattern containing a backslash is
; matched against the path relative to the source folder and must be anchored, and without it this
; entry would install the file anyway and overwrite the operator's edits.
Source: "{#StageDir}\*"; DestDir: "{app}"; Excludes: "\config\launcher.config.json"; \
    Flags: ignoreversion recursesubdirs createallsubdirs

; Reference copy, always refreshed - the upgrade path for anyone whose live config has drifted.
Source: "{#StageDir}\config\launcher.config.json"; DestDir: "{app}\config"; \
    DestName: "launcher.config.default.json"; Flags: ignoreversion

; The live config is only written when absent, so operator edits (LAN addresses, ports, disabling
; the capture service on a machine with no SDI board) are not silently reverted by an upgrade.
Source: "{#StageDir}\config\launcher.config.json"; DestDir: "{app}\config"; Flags: onlyifdoesntexist uninsneveruninstall

[Icons]
; The two products the operator actually uses, each opening as its own desktop window with its own
; taskbar entry and icon. Both run the launcher in app mode; it starts the services first if they
; are not already up, so either shortcut works as the way into the suite on a cold machine.
Name: "{group}\Emerald Capture"; Filename: "{app}\Launcher\{#LauncherExe}"; Parameters: "--app emerald"; \
    WorkingDir: "{app}\Launcher"; IconFilename: "{app}\Launcher\emerald-capture.ico"; \
    Comment: "Emerald capture, recording and playout"
Name: "{group}\LiveEdit"; Filename: "{app}\Launcher\{#LauncherExe}"; Parameters: "--app liveedit"; \
    WorkingDir: "{app}\Launcher"; IconFilename: "{app}\Launcher\liveedit.ico"; \
    Comment: "LiveEdit timeline editing and rendering"

Name: "{group}\{#AppName} Control Panel"; Filename: "{app}\Launcher\{#LauncherExe}"; \
    WorkingDir: "{app}\Launcher"; IconFilename: "{app}\Launcher\emerald.ico"; \
    Comment: "Start, stop and monitor the suite's services"
Name: "{group}\{#AppName} Documentation"; Filename: "{app}\docs"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

Name: "{autodesktop}\Emerald Capture"; Filename: "{app}\Launcher\{#LauncherExe}"; Parameters: "--app emerald"; \
    WorkingDir: "{app}\Launcher"; IconFilename: "{app}\Launcher\emerald-capture.ico"; Tasks: desktopicon
Name: "{autodesktop}\LiveEdit"; Filename: "{app}\Launcher\{#LauncherExe}"; Parameters: "--app liveedit"; \
    WorkingDir: "{app}\Launcher"; IconFilename: "{app}\Launcher\liveedit.ico"; Tasks: desktopicon

Name: "{userstartup}\{#AppName}"; Filename: "{app}\Launcher\{#LauncherExe}"; Parameters: "--minimized"; WorkingDir: "{app}\Launcher"; Tasks: startupicon

[Run]
; One inbound rule per web UI. The API ports (5000/4123) stay closed: the frontends proxy to them
; over loopback, so nothing outside this machine needs to dial them directly.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Emerald Deltacast Suite - Emerald UI"" dir=in action=allow protocol=TCP localport=5173"; \
    Flags: runhidden; StatusMsg: "Adding firewall rules..."; Tasks: firewall
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Emerald Deltacast Suite - LiveEdit UI"" dir=in action=allow protocol=TCP localport=5174"; \
    Flags: runhidden; Tasks: firewall
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Emerald Deltacast Suite - WebRTC preview"" dir=in action=allow protocol=TCP localport=8889"; \
    Flags: runhidden; Tasks: firewall

#if FileExists(AddBackslash(StageDir) + "redist\MicrosoftEdgeWebview2Setup.exe")
; The Emerald Capture and LiveEdit windows are hosted by the Edge WebView2 runtime. It is a Windows
; component and is already present on any current Windows 10/11 machine, so this only runs on the
; rare machine that lacks it - and it needs internet access when it does.
Filename: "{app}\redist\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; \
    StatusMsg: "Installing the Microsoft Edge WebView2 runtime..."; Flags: waituntilterminated; \
    Check: not IsWebView2Installed
#endif

Filename: "{app}\docs\GETTING-STARTED.md"; Description: "Open the getting started guide"; \
    Flags: shellexec postinstall skipifsilent unchecked
Filename: "{app}\Launcher\{#LauncherExe}"; Parameters: "--app emerald"; Description: "Open &Emerald Capture now"; \
    Flags: nowait postinstall skipifsilent
Filename: "{app}\Launcher\{#LauncherExe}"; Parameters: "--app liveedit"; Description: "Open &LiveEdit now"; \
    Flags: nowait postinstall skipifsilent unchecked

[UninstallRun]
; Firewall rules outlive the files that needed them unless they are removed explicitly. Deleting a
; rule that was never added is a no-op, so this runs unconditionally.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Emerald Deltacast Suite - Emerald UI"""; Flags: runhidden; RunOnceId: "DelFwEmerald"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Emerald Deltacast Suite - LiveEdit UI"""; Flags: runhidden; RunOnceId: "DelFwLiveEdit"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Emerald Deltacast Suite - WebRTC preview"""; Flags: runhidden; RunOnceId: "DelFwWhep"

[UninstallDelete]
; Generated at runtime under the install directory; without this the folder is left behind.
Type: filesandordirs; Name: "{app}\Emerald\backend\wwwroot\hls"
Type: dirifempty; Name: "{app}\config"
Type: dirifempty; Name: "{app}"

[Code]
{ The Edge WebView2 runtime registers its version under EdgeUpdate. An empty version string means
  the key exists but no runtime is actually installed, which is why each lookup is tested for a
  non-empty value rather than merely for the key being present. }
{ Pascal Script has no local const section, so this lives at unit scope. }
const
  WebView2ClientKey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2ClientKeyWow = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function IsWebView2Installed: Boolean;
var
  Version: string;
begin
  Result := False;

  { A 64-bit machine-wide install writes to the WOW6432Node view. }
  if RegQueryStringValue(HKEY_LOCAL_MACHINE, WebView2ClientKeyWow, 'pv', Version) then
    Result := Version <> '';

  if not Result then
    if RegQueryStringValue(HKEY_LOCAL_MACHINE, WebView2ClientKey, 'pv', Version) then
      Result := Version <> '';

  { Per-user installs are equally valid for the operator who will run the suite. }
  if not Result then
    if RegQueryStringValue(HKEY_CURRENT_USER, WebView2ClientKey, 'pv', Version) then
      Result := Version <> '';
end;

{ Recordings, exports and the database are the operator's work product, so uninstall leaves them
  in place and simply says where they are. Deleting hundreds of gigabytes of broadcast material
  as a side effect of removing an application is not a decision setup should make silently. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: string;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{commonappdata}\{#DataDirName}');
    if DirExists(DataDir) then
      MsgBox('Your recordings, exports, database and logs have been left in place at:' + #13#10#13#10 +
             DataDir + #13#10#13#10 +
             'Delete that folder by hand if you no longer need them.',
             mbInformation, MB_OK);
  end;
end;
