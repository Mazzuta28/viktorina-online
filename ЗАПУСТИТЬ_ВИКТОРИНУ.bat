@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js не установлен.
  echo Сначала установите Node.js, затем снова откройте этот файл.
  echo.
  pause
  exit /b 1
)

start "СЕРВЕР ВИКТОРИНЫ" cmd /k "cd /d "%~dp0" && node server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000/teacher"
exit
