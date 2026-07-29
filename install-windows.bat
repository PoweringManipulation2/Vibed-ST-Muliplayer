@echo off
setlocal enabledelayedexpansion
title Multiplayer - relay installer

REM ---------------------------------------------------------------------------
REM  Double-clickable wrapper around install.mjs for Windows.
REM
REM  It exists because the common failure is not the install itself, it is that
REM  `node` is not on PATH — the SillyTavern Launcher bundles its own Node and
REM  does not always add it to the system PATH. So this looks for Node in the
REM  places the Launcher and the standard installer put it before giving up.
REM ---------------------------------------------------------------------------

cd /d "%~dp0"

echo.
echo  SillyTavern Multiplayer - relay installer
echo  =========================================
echo.

set "NODE_EXE="

REM 1. Node already on PATH.
where node >nul 2>nul && set "NODE_EXE=node"

REM 2. Standard Node for Windows install locations.
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

REM 3. Node bundled by the SillyTavern Launcher. This extension sits at
REM    <ST>\data\<user>\extensions\<this folder>, so walk up to the Launcher
REM    root and look in the usual spots.
if not defined NODE_EXE (
    for %%D in ("%~dp0..\..\..\.." "%~dp0..\..\..\..\.." "%~dp0..\..\..\..\..\..") do (
        if not defined NODE_EXE if exist "%%~fD\nodejs\node.exe" set "NODE_EXE=%%~fD\nodejs\node.exe"
        if not defined NODE_EXE if exist "%%~fD\node\node.exe" set "NODE_EXE=%%~fD\node\node.exe"
        if not defined NODE_EXE if exist "%%~fD\utils\nodejs\node.exe" set "NODE_EXE=%%~fD\utils\nodejs\node.exe"
    )
)

if not defined NODE_EXE (
    echo  [X] Could not find node.exe.
    echo.
    echo      Node.js ships with SillyTavern, so it is on your machine somewhere.
    echo      Find node.exe, then run this from a terminal instead:
    echo.
    echo          "C:\path\to\node.exe" install.mjs --enable
    echo.
    echo      Or install Node from https://nodejs.org and re-run this file.
    echo.
    pause
    exit /b 1
)

echo  Using Node: !NODE_EXE!
for /f "delims=" %%V in ('"!NODE_EXE!" --version 2^>nul') do echo  Version:    %%V
echo.

"!NODE_EXE!" install.mjs --enable
set "RESULT=!ERRORLEVEL!"

echo.
if "!RESULT!"=="0" (
    echo  ---------------------------------------------------------------
    echo   Next step: FULLY CLOSE SillyTavern and start it again.
    echo.
    echo   Reloading the browser page is not enough. Plugins are only
    echo   loaded while the server is starting up, so the server process
    echo   itself has to restart.
    echo.
    echo   On restart, the SillyTavern console window should print a line
    echo   containing "st-multiplayer". If it does not, server plugins are
    echo   still disabled in config.yaml.
    echo  ---------------------------------------------------------------
) else (
    echo  The installer reported a problem ^(exit code !RESULT!^). Read the
    echo  message above - it names the folder or setting that needs fixing.
)

echo.
pause
exit /b !RESULT!
