#define AppName "SayGM"

#ifndef AppVersion
  #error AppVersion must be supplied by the build workflow.
#endif
#ifndef SourceDir
  #error SourceDir must be supplied by the build workflow.
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by the build workflow.
#endif

[Setup]
AppId={{82B0119A-360B-4B7E-B073-A57D829A0871}
AppName={#AppName} Desktop
AppVersion={#AppVersion}
AppVerName={#AppName} Desktop {#AppVersion}
AppPublisher=SayGM
AppPublisherURL=https://saygm.com/
DefaultDirName={localappdata}\Programs\SayGM
DefaultGroupName=SayGM
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=SayGM-{#AppVersion}-Setup-x64-unsigned
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=SayGM Desktop
UninstallDisplayIcon={app}\SayGM.exe
CloseApplications=yes
RestartApplications=no
SetupLogging=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\SayGM"; Filename: "{app}\SayGM.exe"
Name: "{autodesktop}\SayGM"; Filename: "{app}\SayGM.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\SayGM.exe"; Description: "Launch SayGM"; Flags: postinstall skipifsilent

[Code]
function ProtocolHandlerIsOwnedByThisInstall: Boolean;
var
  Command: string;
  Executable: string;
  ExpectedExecutable: string;
  QuotePos: Integer;
begin
  Result := False;
  if not RegQueryStringValue(HKEY_CURRENT_USER,
    'Software\Classes\saygm\shell\open\command', '', Command) then
    Exit;

  if (Length(Command) >= 2) and (Command[1] = '"') then
  begin
    QuotePos := Pos('"', Copy(Command, 2, Length(Command)));
    if QuotePos = 0 then
      Exit;
    Executable := Copy(Command, 2, QuotePos - 1);
  end
  else
  begin
    QuotePos := Pos(' ', Command);
    if QuotePos = 0 then
      Executable := Command
    else
      Executable := Copy(Command, 1, QuotePos - 1);
  end;

  ExpectedExecutable := ExpandConstant('{app}\SayGM.exe');
  Result := CompareText(Executable, ExpectedExecutable) = 0;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usUninstall) and ProtocolHandlerIsOwnedByThisInstall then
    RegDeleteKeyIncludingSubkeys(HKEY_CURRENT_USER, 'Software\Classes\saygm');
end;
