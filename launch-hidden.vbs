' Launches Claude UI (dev mode) with no visible console window.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\ClaudeUI"
sh.Run """D:\ClaudeUI\node_modules\.bin\electron.cmd"" .", 0, False
