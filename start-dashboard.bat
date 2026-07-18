@echo off
REM Career-Ops Dashboard Server — Background Service
REM Starts the interactive dashboard on port 3737
REM Accessible via Tailscale from any device: http://100.93.238.88:3737
REM
REM Auto-starts via Task Scheduler on login.
REM Install:  schtasks /create /tn "Career-Ops Dashboard" /tr "C:\Users\Lukas\career-ops\start-dashboard.bat" /sc onlogon /rl highest /f
REM Remove:   schtasks /delete /tn "Career-Ops Dashboard" /f
REM Restart:  taskkill /f /fi "WINDOWTITLE eq Career-Ops Dashboard" & start "" "C:\Users\Lukas\career-ops\start-dashboard.bat"

title Career-Ops Dashboard
cd /d C:\Users\Lukas\career-ops

:loop
echo [%date% %time%] Starting dashboard server... >> data\dashboard-log.txt
"C:\Program Files\nodejs\node.exe" dashboard-server.mjs >> data\dashboard-log.txt 2>&1
echo [%date% %time%] Server exited, restarting in 10s... >> data\dashboard-log.txt
timeout /t 10 /nobreak > nul
goto loop
