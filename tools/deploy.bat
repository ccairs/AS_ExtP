@echo off
chcp 437 >nul 2>nul
setlocal enabledelayedexpansion
title AS_ExtP Deploy

:: ============================================
:: Deploy the extension into the CEP extensions directory.
:: Administrator rights are required (Program Files is write-protected).
:: Console output is ASCII English only (chcp 437).
:: ============================================

net session >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Administrator privileges required - elevating...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

set "SCRIPT_DIR=%~dp0"
for %%i in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fi"

set "DEST=C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\AS_ExtP"

:: Safety gate: DEST must end with AS_ExtP so a bad value cannot wipe a system directory.
set "DEST_END=!DEST:~-8!"
if /I not "!DEST_END!"=="\AS_ExtP" (
    echo [ERROR] DEST must end with \AS_ExtP -- refusing to operate on: !DEST!
    pause
    exit /b 1
)

echo.
echo ========================================
echo   AS_ExtP Deploy
echo ========================================
echo.
echo   Source : !REPO_ROOT!
echo   Dest   : !DEST!
echo.

:: Check that the source tree is complete.
set MISSING=0
for %%d in (host client CSXS vendor) do (
    if not exist "!REPO_ROOT!\%%d\" (
        echo   [ERROR] Missing: !REPO_ROOT!\%%d
        set /a MISSING+=1
    )
)
:: Check that vendor binaries are real files (an LFS pointer is only ~130 bytes).
for %%f in (vendor\node\node.exe vendor\ffmpeg\ffmpeg.exe vendor\ffmpeg\ffprobe.exe) do (
    if exist "!REPO_ROOT!\%%f" (
        set SIZE=0
        for %%s in ("!REPO_ROOT!\%%f") do set SIZE=%%~zs
        if !SIZE! lss 1024 (
            echo   [WARN] %%f is LFS pointer ^(!SIZE! bytes^) - run check-env.bat first to download
        )
    )
)
if !MISSING! gtr 0 (
    echo.
    echo   Some files are missing. check-env.bat can auto-download them.
    echo.
    choice /C YN /N /M "Run check-env.bat now? (Y/N): "
    if not errorlevel 2 (
        call "!REPO_ROOT!\tools\check-env.bat"
    )
    pause
    exit /b 1
)

:: Close AE first: deploying while AE is open can hit file locks.
tasklist /FI "IMAGENAME eq AfterFX.exe" 2>nul | findstr AfterFX >nul
if %errorlevel%==0 (
    echo   [!] After Effects is running.
    echo   [!] Deploying while AE is open may cause file locks.
    echo.
    choice /C YN /N /M "Continue anyway? (Y/N): "
    if errorlevel 2 exit /b
)

:: Confirm before replacing the deployed copy.
echo   This will replace everything in:
echo   !DEST!
echo.
choice /C YN /N /M "Proceed? (Y/N): "
if errorlevel 2 exit /b
echo.

:: Source checkout: copy the root node_modules into vendor\node_modules.
:: The deployed bridge resolves dependencies from <extension root>\vendor\node_modules
:: (mammoth / @wwek/xlsx / unpdf for docx / xlsx / pdf attachment parsing). The Release
:: package already ships that directory, so this step is skipped there; a source clone
:: that only ran npm ci (root node_modules) is completed here.
if not exist "!REPO_ROOT!\vendor\node_modules\@wwek\xlsx\xlsx.js" (
    if exist "!REPO_ROOT!\node_modules\" (
        echo   [0/6] Copying node_modules to vendor\node_modules...
        robocopy "!REPO_ROOT!\node_modules" "!REPO_ROOT!\vendor\node_modules" /E /NJH /NJS /NP /NS /NDL /R:2 /W:2 >nul
        if exist "!REPO_ROOT!\tools\prune-vendor-modules.js" (
            if exist "!REPO_ROOT!\vendor\node\node.exe" (
                "!REPO_ROOT!\vendor\node\node.exe" "!REPO_ROOT!\tools\prune-vendor-modules.js" >nul 2>nul
            ) else (
                node "!REPO_ROOT!\tools\prune-vendor-modules.js" >nul 2>nul
            )
            if errorlevel 1 echo   [WARN] prune-vendor-modules failed - vendor may still contain dev packages
        )
    )
)
if not exist "!REPO_ROOT!\vendor\node_modules\@wwek\xlsx\xlsx.js" (
    echo   [WARN] vendor\node_modules missing - docx/xlsx/pdf attachment parsing unavailable
    echo          Run npm ci first, then re-run this script ^(or use the Release package^)
)

:: Remove the previous deployment (only the known directories, never user files).
echo   [1/6] Cleaning old deployment...
for %%d in (host client CSXS vendor) do (
    if exist "!DEST!\%%d\" (
        rmdir /S /Q "!DEST!\%%d" 2>nul
        if exist "!DEST!\%%d\" echo   [WARN] Could not remove %%d (file in use?^)
    )
)

:: Create the destination directory.
if not exist "!DEST!" mkdir "!DEST!"

:: Copy the extension tree.
echo   [2/6] Copying host\
robocopy "!REPO_ROOT!\host" "!DEST!\host" /E /NJH /NJS /NP /NS /NDL /R:2 /W:2 >nul

echo   [3/6] Copying client\
robocopy "!REPO_ROOT!\client" "!DEST!\client" /E /NJH /NJS /NP /NS /NDL /R:2 /W:2 >nul

echo   [4/6] Copying CSXS\
robocopy "!REPO_ROOT!\CSXS" "!DEST!\CSXS" /E /NJH /NJS /NP /NS /NDL /R:2 /W:2 >nul

echo   [5/6] Copying vendor\
robocopy "!REPO_ROOT!\vendor" "!DEST!\vendor" /E /NJH /NJS /NP /NS /NDL /R:2 /W:2 >nul

if exist "!REPO_ROOT!\LICENSE" copy /Y "!REPO_ROOT!\LICENSE" "!DEST!\LICENSE" >nul 2>nul
set "NOTICES_SRC=!REPO_ROOT!\docs\THIRD-PARTY-NOTICES.md"
if not exist "!NOTICES_SRC!" set "NOTICES_SRC=!REPO_ROOT!\tools\public-overlay\docs\THIRD-PARTY-NOTICES.md"
if exist "!NOTICES_SRC!" copy /Y "!NOTICES_SRC!" "!DEST!\THIRD-PARTY-NOTICES.md" >nul 2>nul

:: Verify the deployed tree.
echo.
echo ========================================
echo   [6/6] Verify
echo ========================================

set VERIFY_OK=1
for %%d in (host client CSXS vendor) do (
    if not exist "!DEST!\%%d\" (
        echo   [FAIL] %%d\ missing
        set VERIFY_OK=0
    ) else (
        echo   [OK]  %%d\
    )
)
if exist "!DEST!\THIRD-PARTY-NOTICES.md" (
    echo   [OK]  THIRD-PARTY-NOTICES.md
) else (
    echo   [WARN] THIRD-PARTY-NOTICES.md missing
)
if exist "!DEST!\LICENSE" (
    echo   [OK]  LICENSE
) else (
    echo   [WARN] LICENSE missing
)

if not exist "!DEST!\vendor\node\node.exe" (
    echo   [WARN] vendor\node\node.exe missing - bridge will use system Node.js
)
if not exist "!DEST!\vendor\ffmpeg\ffmpeg.exe" (
    echo   [WARN] vendor\ffmpeg\ffmpeg.exe missing - MOV transcode unavailable
)

echo.
if !VERIFY_OK!==1 (
    echo   Deploy complete.
    echo.
    echo   Next: Restart AE ^> Window ^> Extensions ^> AS_ExtP
) else (
    echo   [!] Some directories failed to copy. Check file permissions.
)
echo.
pause
