' 창을 띄우지 않고 run.bat 을 실행한다 (작업 스케줄러용)
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & base & "\run.bat""", 0, False
