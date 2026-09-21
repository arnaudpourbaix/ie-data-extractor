@echo off
setlocal

if "%~1"=="" (
    echo Usage: extract-spells-merge.bat ^<origin^>
    exit /b 1
)

set "ORIGIN=%~1"
set "DESTINATION=extract\csv\spells.csv"
set "MERGESCRIPT=scripts\extract-spells.js"

cd /d "%~dp0"

if not exist "weidu.exe" (
    echo weidu.exe not found in %~dp0 - this script must live in the game root.
    exit /b 1
)
if not exist "%MERGESCRIPT%" (
    echo merge script not found: %MERGESCRIPT%
    exit /b 1
)

echo Installing extract spells component...
.\weidu.exe extract\extract.tp2 --yes --force-install 3 >nul
if errorlevel 1 (
    echo weidu install failed with exit code %ERRORLEVEL%
    exit /b 1
)

echo Merging spells_source.csv into %DESTINATION% (origin=%ORIGIN%)...
node "%MERGESCRIPT%" --origin %ORIGIN% --destination "%DESTINATION%"
if errorlevel 1 (
    echo merge script failed with exit code %ERRORLEVEL%
    exit /b 1
)

echo Done.

endlocal
