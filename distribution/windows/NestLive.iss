#ifndef SourceDir
  #define SourceDir "."
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

#define AppName "NestLive"
#define Publisher "MillionsNest"
#define ServiceExe "NestLiveService.exe"

[Setup]
AppId={{27DA6367-11F0-48F7-B6D3-E2CE4F28B94A}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#Publisher}
DefaultDirName={localappdata}\NestLive
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=NestLiveSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
UninstallDisplayName={#AppName}
CloseApplications=yes
RestartApplications=no
SetupLogging=yes

[Files]
Source: "{#SourceDir}\NestLiveService.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\NestLiveAudioNode.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\NestLiveProductionNode.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\web\*"; DestDir: "{app}\web"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\README-INSTALL.md"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "NestLive"; ValueData: """{app}\{#ServiceExe}"""; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#ServiceExe}"; Description: "Iniciar NestLive"; Flags: nowait postinstall skipifsilent
Filename: "http://127.0.0.1:4317/local"; Description: "Abrir NestLive"; Flags: shellexec postinstall skipifsilent nowait

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/IM NestLiveService.exe /F"; Flags: runhidden waituntilterminated
Filename: "{sys}\taskkill.exe"; Parameters: "/IM NestLiveAudioNode.exe /F"; Flags: runhidden waituntilterminated
Filename: "{sys}\taskkill.exe"; Parameters: "/IM NestLiveProductionNode.exe /F"; Flags: runhidden waituntilterminated

[Code]
procedure InitializeWizard;
begin
  WizardForm.Caption := 'NestLive';
  WizardForm.WelcomeLabel1.Caption := 'Instalar NestLive';
  WizardForm.WelcomeLabel2.Caption :=
    'Prepare este computador para operar o culto com NestLive.' + #13#10 + #13#10 +
    'A configuracao normal nao exige Git, terminal, IP ou porta.';
end;
