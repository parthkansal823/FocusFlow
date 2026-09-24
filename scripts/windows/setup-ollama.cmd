@echo off
rem Double-click to set up FocusFlow's thinking AI on this PC (see setup-ollama.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-ollama.ps1" %*
pause
