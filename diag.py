import os, sys, getpass, json, pathlib
exe = os.path.join(os.environ.get("LOCALAPPDATA",""), "ms-playwright",
                   "chromium_headless_shell-1234", "chrome-headless-shell-win64",
                   "chrome-headless-shell.exe")
info = {
  "whoami": getpass.getuser(),
  "LOCALAPPDATA": os.environ.get("LOCALAPPDATA"),
  "USERPROFILE": os.environ.get("USERPROFILE"),
  "PLAYWRIGHT_BROWSERS_PATH": os.environ.get("PLAYWRIGHT_BROWSERS_PATH"),
  "exe_path": exe,
  "exe_exists": os.path.exists(exe),
  "exe_isfile": os.path.isfile(exe),
  "can_read": os.access(exe, os.R_OK),
  "can_exec": os.access(exe, os.X_OK),
  "ms_playwright_listdir": None,
}
try:
    info["ms_playwright_listdir"] = os.listdir(os.path.join(os.environ.get("LOCALAPPDATA",""), "ms-playwright"))
except Exception as e:
    info["ms_playwright_listdir"] = f"ERROR: {e}"
try:
    with open(exe, "rb") as f:
        info["first_bytes"] = f.read(2).hex()
except Exception as e:
    info["first_bytes"] = f"ERROR: {e}"
print(json.dumps(info, ensure_ascii=False, indent=2))
