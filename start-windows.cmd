@echo off
setlocal enabledelayedexpansion
title Filament Library

rem  Double-click launcher for running without Docker.
rem
rem  Deliberately defensive: this is the one file run by someone who won't open
rem  a terminal to read an error, so every failure says what to do about it and
rem  leaves the window open long enough to be read.
rem
rem  The filename has no spaces on purpose — a .cmd with a space in its name is
rem  fine to double-click but a nuisance everywhere else it gets referenced.

cd /d "%~dp0"

echo.
echo   Filament Library
echo   ================
echo.

rem ── Node present? ────────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js isn't installed, and the app needs it to run.
  echo.
  echo   Get the "LTS" version from:  https://nodejs.org
  echo   Install it with all the default options, then run this again.
  echo.
  echo   Opening the download page...
  start "" "https://nodejs.org"
  echo.
  pause
  exit /b 1
)

rem ── New enough? node:sqlite is built in from 22.5, and the app relies on it ──
for /f "tokens=1,2 delims=." %%a in ('node -p "process.versions.node"') do (
  set MAJOR=%%a
  set MINOR=%%b
)

set TOO_OLD=
if !MAJOR! LSS 22 set TOO_OLD=1
if !MAJOR! EQU 22 if !MINOR! LSS 5 set TOO_OLD=1

if defined TOO_OLD (
  for /f %%v in ('node -p "process.versions.node"') do set FOUND=%%v
  echo   Node.js !FOUND! is installed, but this needs 22.5 or newer —
  echo   the database support the app uses was added in that version.
  echo.
  echo   Install the current "LTS" release from:  https://nodejs.org
  echo.
  start "" "https://nodejs.org"
  pause
  exit /b 1
)

rem ── First run: fetch the handful of libraries the server needs ───────────────
if not exist "node_modules\express" (
  echo   First run — downloading the bits the server needs.
  echo   This needs the internet, takes a minute, and only happens once.
  echo.
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   That didn't work. The usual cause is no internet connection.
    echo   Check the connection and run this again.
    echo.
    pause
    exit /b 1
  )
  echo.
)

rem ── Settings. All optional; these are the defaults ───────────────────────────
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    if not "%%b"=="" set "%%a=%%b"
  )
)

if not defined PORT set PORT=8088

rem  DB_PATH is deliberately left alone. The app puts the database in
rem  LocalAppData on Windows, which is the one folder OneDrive never syncs —
rem  and a synced folder and a SQLite database do not get along. Set DB_PATH in
rem  .env only if you want it somewhere specific, and keep it off OneDrive.
if not defined DB_PATH set "DB_PATH=%LOCALAPPDATA%\FilamentLibrary\filament.db"

rem ── Off we go ────────────────────────────────────────────────────────────────
echo   Starting up...
echo.
echo   Open it at:               http://localhost:%PORT%
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
  for /f "tokens=1" %%j in ("%%i") do echo   From a phone or tablet:   http://%%j:%PORT%
)
echo.
echo   Your filament list is saved at:
echo   %DB_PATH%
echo.
echo   Settings ^> Download a backup saves a copy wherever you like.
echo.
echo   Leave this window open while you're using it.
echo   Closing it, or pressing Ctrl+C, stops the app.
echo.

rem  Opened from a separate process after a short wait, so the browser doesn't
rem  arrive before the server is listening and show a connection error on a
rem  perfectly good start. PowerShell rather than nested cmd quoting, which is
rem  where an earlier version of this went wrong.
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%PORT%'"

node server/index.js
set EXITCODE=%ERRORLEVEL%

rem  Reached when the server stops, cleanly or otherwise. Without the pause the
rem  window vanishes and takes the reason with it.
echo.
echo   The app has stopped.
if not "%EXITCODE%"=="0" (
  echo.
  echo   Something went wrong — the message above says what.
  echo   A common one is port %PORT% already being in use, which usually means
  echo   the app is already running in another window.
)
echo.
pause
