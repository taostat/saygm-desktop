@ECHO OFF
SETLOCAL EnableDelayedExpansion

SET "SAYGM_NODE_DIR=%LOCALAPPDATA%\SayGM\node"
SET "NODE_VERSION=22.14.0"

REM === Check for previously downloaded portable Node.js (matching version) ===
if exist "%SAYGM_NODE_DIR%\node-v%NODE_VERSION%.installed" (
    SET "PATH=%SAYGM_NODE_DIR%;!PATH!"
    "%SAYGM_NODE_DIR%\npx.cmd" %*
    exit /b !errorlevel!
)

REM === Download portable Node.js ===
echo [SayGM] Node.js not found. Downloading portable Node.js v%NODE_VERSION%... 1>&2

SET "NODE_ZIP=%TEMP%\saygm-node-%NODE_VERSION%.zip"
SET "NODE_EXTRACT=%TEMP%\saygm-node-extract"

powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip' -OutFile '%NODE_ZIP%' -UseBasicParsing; Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '%NODE_EXTRACT%' -Force; exit 0 } catch { Write-Error $_.Exception.Message; exit 1 }"
if errorlevel 1 (
    echo [SayGM] ERROR: Failed to download Node.js. Please install manually from https://nodejs.org/ 1>&2
    del "%NODE_ZIP%" >nul 2>&1
    exit /b 1
)

REM Replace SayGM's cached Node.js version
rmdir /s /q "%SAYGM_NODE_DIR%" >nul 2>&1
mkdir "%SAYGM_NODE_DIR%" >nul 2>&1
xcopy /s /e /q /y "%NODE_EXTRACT%\node-v%NODE_VERSION%-win-x64\*" "%SAYGM_NODE_DIR%\" >nul 2>&1

REM Clean up
del "%NODE_ZIP%" >nul 2>&1
rmdir /s /q "%NODE_EXTRACT%" >nul 2>&1

if exist "%SAYGM_NODE_DIR%\npx.cmd" (
    echo.>"%SAYGM_NODE_DIR%\node-v%NODE_VERSION%.installed"
    SET "PATH=%SAYGM_NODE_DIR%;!PATH!"
    echo [SayGM] Node.js v%NODE_VERSION% ready. 1>&2
    "%SAYGM_NODE_DIR%\npx.cmd" %*
    exit /b !errorlevel!
)

echo [SayGM] ERROR: Installation failed. Please install Node.js manually from https://nodejs.org/ 1>&2
exit /b 1
