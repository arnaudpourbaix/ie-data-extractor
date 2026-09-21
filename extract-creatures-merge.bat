@echo off
setlocal

if "%~1"=="" (
    echo Usage: extract-creatures-merge.bat ^<origin^>
    exit /b 1
)

set "ORIGIN=%~1"
set "DESTINATION=extract\csv\creatures.csv"
set "MERGESCRIPT=scripts\extract-creatures.js"
set "SNAPSHOT=extract\csv\source.csv.snapshot"

cd /d "%~dp0"

if not exist "weidu.exe" (
    echo weidu.exe not found in %~dp0 - this script must live in the game root.
    exit /b 1
)
if not exist "%MERGESCRIPT%" (
    echo merge script not found: %MERGESCRIPT%
    exit /b 1
)

echo Installing extract component...
.\weidu.exe extract\extract.tp2 --yes --force-install 0 >nul
if errorlevel 1 (
    echo weidu install failed with exit code %ERRORLEVEL%
    exit /b 1
)

echo Snapshotting source.csv...
copy /y "extract\csv\source.csv" "%SNAPSHOT%" >nul

echo Merging snapshot into %DESTINATION% (origin=%ORIGIN%)...
node "%MERGESCRIPT%" --origin %ORIGIN% --destination "%DESTINATION%" --source "%SNAPSHOT%"
if errorlevel 1 (
    echo merge script failed with exit code %ERRORLEVEL%
    exit /b 1
)

del "%SNAPSHOT%"
echo Done.

endlocal
