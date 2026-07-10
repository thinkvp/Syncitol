; Syncitol CEP installer (Windows).
;
; Fixes the fiddly manual install path (enabling PlayerDebugMode for the
; right CSXS version, then hand-copying the extension folder) with a normal
; double-click installer. No admin rights needed — everything it touches
; lives under the current user's profile.
;
; Build with: iscc syncitol-cep-installer.iss /DMyAppVersion=1.4.0
; (MyAppVersion falls back to "0.0.0-dev" for local test builds if omitted.)
;
; Expects the runtime files to already be staged at ..\dist\staging\ — run
; `node ../scripts/stage.js` first (build-zxp.js does this too, but also
; signs a .zxp, which isn't needed here).

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0-dev"
#endif

#define MyAppName "Syncitol"
#define MyAppPublisher "thinkvp"
#define MyAppURL "https://github.com/thinkvp/Syncitol"
#define StagingDir "..\dist\staging"

[Setup]
AppId={{B6C6B9B4-6E13-4C0E-9C7B-6B6E6C2E6B6C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={userappdata}\Adobe\CEP\extensions\Syncitol
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Syncitol-CEP-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\css\style.css
ArchitecturesInstallIn64BitMode=x64compatible

[Registry]
; Premiere only loads unsigned/self-signed CEP extensions when the matching
; CSXS-version debug flag is set. Cover the whole range we've seen in the
; wild (Premiere Pro ~2019 through 2026) rather than trying to detect the
; installed version.
;
; Deliberately NOT using `uninsdeletevalue` here: PlayerDebugMode is a
; shared, systemwide CEP developer flag, not something this installer owns
; exclusively. Deleting it on uninstall could silently break any other
; unsigned/self-signed CEP extension the user has installed.
Root: HKCU; Subkey: "Software\Adobe\CSXS.9";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.13"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.14"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"

[Files]
Source: "{#StagingDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Messages]
FinishedLabel=Setup has installed Syncitol.%n%nRestart Premiere Pro if it's running, then find the panel under Window %26 Extensions %26 Syncitol.
