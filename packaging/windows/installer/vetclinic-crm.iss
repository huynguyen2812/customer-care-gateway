; VETCLINIC CRM — bộ cài bản chạy trên PC (Inno Setup 6). Build: release.ps1 (truyền /DVersion=… /DStageDir=…).
; Không chứa secret: mọi secret được sinh lúc cài (install.ps1). Chưa ký số (chưa có chứng thư) ⇒ SmartScreen sẽ cảnh báo.
#ifndef Version
  #error Pass /DVersion=<version>
#endif
#ifndef StageDir
  #error Pass /DStageDir=<stage\app\version>
#endif

[Setup]
AppId={{6E2B5C1A-9F3D-4C7E-A1B8-3C5D7E9F1A2B}
AppName=VETCLINIC CRM
AppVersion={#Version}
AppVerName=VETCLINIC CRM {#Version}
AppPublisher=VETCLINIC
DefaultDirName={commonpf64}\VETCLINIC CRM
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
Compression=lzma2/max
SolidCompression=yes
LZMANumBlockThreads=4
OutputDir=..\..\..\..\build\installer
OutputBaseFilename=VETCLINIC-CRM-Setup-{#Version}
WizardStyle=modern
InfoBeforeFile=installer-info.txt
UninstallDisplayName=VETCLINIC CRM
UninstallDisplayIcon={sys}\shell32.dll,13
CloseApplications=no
SetupLogging=yes

[Languages]
Name: "default"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}\app\{#Version}"; Flags: recursesubdirs createallsubdirs ignoreversion

[UninstallDelete]
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\services"
Type: files; Name: "{app}\current-version.txt"

[Run]
Filename: "http://127.0.0.1:47100/"; Description: "Mở VETCLINIC CRM"; Flags: postinstall shellexec nowait skipifsilent
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\app\{#Version}\scripts\tray.ps1"""; Flags: runasoriginaluser nowait postinstall skipifsilent runhidden; Description: "Hiện biểu tượng trạng thái dưới khay đồng hồ"

[Code]
var
  ModePage: TInputOptionWizardPage;
  RestorePage: TWizardPage;
  BackupFileEdit, RecoveryKeyEdit: TNewEdit;
  KeyPage: TOutputMsgMemoWizardPage;
  KeySaved: TNewCheckBox;
  IsUpgrade, ShowKey, InstallOk: Boolean;
  ErrorText: String;

function PS(): String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function AppDir(): String;
begin
  Result := ExpandConstant('{app}\app\{#Version}');
end;

procedure BrowseBackup(Sender: TObject);
var F: String;
begin
  F := BackupFileEdit.Text;
  if GetOpenFileName('Chọn file sao lưu VETCLINIC CRM', F, '', 'Bản sao lưu (*.vcbak)|*.vcbak', 'vcbak') then BackupFileEdit.Text := F;
end;

procedure InitializeWizard();
var Btn: TNewButton; L1, L2: TNewStaticText;
begin
  IsUpgrade := FileExists(ExpandConstant('{commonpf64}\VETCLINIC CRM\current-version.txt'));
  ModePage := CreateInputOptionPage(wpInfoBefore, 'Kiểu cài đặt', 'Cài mới hay khôi phục dữ liệu từ máy cũ?',
    'Chọn "Khôi phục" khi máy cũ bị hỏng và bạn có file sao lưu (.vcbak) cùng KHÓA KHÔI PHỤC.', True, False);
  ModePage.Add('Cài mới (thiết lập doanh nghiệp lần đầu)');
  ModePage.Add('Khôi phục từ bản sao lưu');
  ModePage.SelectedValueIndex := 0;

  RestorePage := CreateCustomPage(ModePage.ID, 'Khôi phục dữ liệu', 'Chọn file sao lưu và nhập khóa khôi phục (dạng XXXX-XXXX-…).');
  L1 := TNewStaticText.Create(RestorePage); L1.Parent := RestorePage.Surface; L1.Caption := 'File sao lưu (.vcbak):';
  BackupFileEdit := TNewEdit.Create(RestorePage); BackupFileEdit.Parent := RestorePage.Surface; BackupFileEdit.Top := L1.Top + 18; BackupFileEdit.Width := RestorePage.SurfaceWidth - 90;
  Btn := TNewButton.Create(RestorePage); Btn.Parent := RestorePage.Surface; Btn.Caption := 'Chọn…'; Btn.Top := BackupFileEdit.Top - 1; Btn.Left := BackupFileEdit.Width + 10; Btn.Width := 75; Btn.OnClick := @BrowseBackup;
  L2 := TNewStaticText.Create(RestorePage); L2.Parent := RestorePage.Surface; L2.Caption := 'Khóa khôi phục:'; L2.Top := BackupFileEdit.Top + 40;
  RecoveryKeyEdit := TNewEdit.Create(RestorePage); RecoveryKeyEdit.Parent := RestorePage.Surface; RecoveryKeyEdit.Top := L2.Top + 18; RecoveryKeyEdit.Width := RestorePage.SurfaceWidth;

  KeyPage := CreateOutputMsgMemoPage(wpInstalling, 'KHÓA KHÔI PHỤC — chỉ hiện MỘT lần',
    'In ra giấy hoặc chép vào nơi an toàn NGOÀI máy này. VETCLINIC không giữ bản sao.',
    'Khóa này cùng file sao lưu (.vcbak) là cách DUY NHẤT để lấy lại dữ liệu khi máy hỏng. Mất khóa + hỏng máy = mất dữ liệu.', '');
  KeySaved := TNewCheckBox.Create(KeyPage); KeySaved.Parent := KeyPage.Surface; KeySaved.Width := KeyPage.SurfaceWidth;
  KeySaved.Caption := 'Tôi đã in / chép khóa khôi phục ra nơi an toàn';
  { Shrink the memo FIRST, then place the checkbox in the freed space at the bottom of the page surface
    (placing it below the full-height memo put it outside the visible area). }
  KeySaved.Height := ScaleY(20);
  KeyPage.RichEditViewer.Height := KeyPage.SurfaceHeight - KeyPage.RichEditViewer.Top - KeySaved.Height - ScaleY(8);
  KeySaved.Top := KeyPage.RichEditViewer.Top + KeyPage.RichEditViewer.Height + ScaleY(6);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if (PageID = ModePage.ID) then Result := IsUpgrade;
  if (PageID = RestorePage.ID) then Result := IsUpgrade or (ModePage.SelectedValueIndex <> 1);
  if (PageID = KeyPage.ID) then Result := not ShowKey;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = RestorePage.ID) then begin
    if not FileExists(BackupFileEdit.Text) then begin MsgBox('Hãy chọn file sao lưu .vcbak.', mbError, MB_OK); Result := False; end
    else if Length(Trim(RecoveryKeyEdit.Text)) < 40 then begin MsgBox('Khóa khôi phục chưa đúng (gồm 40 ký tự, có thể có dấu gạch).', mbError, MB_OK); Result := False; end;
  end;
  if (CurPageID = KeyPage.ID) and not KeySaved.Checked then begin
    MsgBox('Hãy xác nhận đã lưu khóa khôi phục trước khi tiếp tục.', mbError, MB_OK); Result := False;
  end;
end;

function RunScript(const Params: String): Integer;
var Code: Integer;
begin
  if not Exec(PS(), '-NoProfile -NonInteractive -ExecutionPolicy Bypass ' + Params, '', SW_HIDE, ewWaitUntilTerminated, Code) then Code := -1;
  Result := Code;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var Code: Integer; KeyFile, OutFile, Params, SilentOut: String; Lines: AnsiString;
begin
  if CurStep <> ssPostInstall then exit;
  InstallOk := False;
  if IsUpgrade then begin
    WizardForm.StatusLabel.Caption := 'Đang cập nhật (sao lưu trước, rồi chuyển sang bản mới)…';
    Code := RunScript('-File "' + AppDir() + '\scripts\update.ps1" -NewAppDir "' + AppDir() + '"');
    InstallOk := (Code = 0);
    if not InstallOk then ErrorText := 'Cập nhật không thành công; bản cũ vẫn đang chạy. Xem log trong C:\ProgramData\VETCLINIC CRM\logs.';
  end else begin
    WizardForm.StatusLabel.Caption := 'Đang cài cơ sở dữ liệu và dịch vụ (vài phút)…';
    OutFile := ExpandConstant('{tmp}\recovery.txt');
    Params := '-File "' + AppDir() + '\scripts\install.ps1" -StageDir "' + AppDir() + '" -InPlace -RecoveryOut "' + OutFile + '"';
    if ModePage.SelectedValueIndex = 1 then begin
      KeyFile := ExpandConstant('{tmp}\rk.txt');
      SaveStringToFile(KeyFile, Trim(RecoveryKeyEdit.Text), False);
      Params := Params + ' -RestoreFrom "' + BackupFileEdit.Text + '" -RecoveryKeyFile "' + KeyFile + '"';
    end;
    Code := RunScript(Params);
    DeleteFile(ExpandConstant('{tmp}\rk.txt'));
    InstallOk := (Code = 0) or (Code = 2);
    if not InstallOk then ErrorText := 'Cài đặt không thành công. Xem log trong C:\ProgramData\VETCLINIC CRM\logs.';
    if FileExists(OutFile) and LoadStringFromFile(OutFile, Lines) then begin
      SilentOut := ExpandConstant('{param:RECOVERYOUT|}');
      if WizardSilent() and (SilentOut <> '') then SaveStringToFile(SilentOut, Lines, False);
      KeyPage.RichEditViewer.Lines.Text := UTF8Decode(Lines);
      ShowKey := not WizardSilent();
      DeleteFile(OutFile);
    end;
  end;
  if not InstallOk then begin
    if not WizardSilent() then MsgBox(ErrorText, mbError, MB_OK);
    Log('VETCLINIC CRM: ' + ErrorText);
  end;
end;

{ Silent installs (/VERYSILENT) must not report success when install.ps1 / update.ps1 failed. }
function GetCustomSetupExitCode(): Integer;
begin
  if InstallOk then Result := 0 else Result := 10;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var Ver: AnsiString; Code: Integer; Script: String;
begin
  if CurUninstallStep <> usUninstall then exit;
  if LoadStringFromFile(ExpandConstant('{app}\current-version.txt'), Ver) then begin
    Script := ExpandConstant('{app}\app\') + Trim(String(Ver)) + '\scripts\uninstall.ps1';
    if FileExists(Script) then
      Exec(PS(), '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Script + '" -ServicesOnly', '', SW_HIDE, ewWaitUntilTerminated, Code);
  end;
  if not UninstallSilent() then
    MsgBox('Đã gỡ VETCLINIC CRM. Dữ liệu (cơ sở dữ liệu, bản sao lưu) VẪN GIỮ tại C:\ProgramData\VETCLINIC CRM. Xóa thư mục đó bằng tay nếu chắc chắn không cần nữa.', mbInformation, MB_OK);
end;
