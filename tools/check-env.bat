@echo off
setlocal enabledelayedexpansion
title AS_ExtP Environment Check

chcp 437 >nul 2>nul

:: Console output is ASCII only under chcp 437; this script itself must stay pure ASCII (release gate)
:: All logic in :Main, guaranteed pause at top-level
call :Main
echo.
pause
exit /b

:Main
set "SCRIPT_DIR=%~dp0"
for %%i in ("!SCRIPT_DIR!..") do set "REPO_ROOT=%%~fi"

echo.
echo ========================================
echo   AS_ExtP Environment Check
echo ========================================
echo.

set PASS=0
set FAIL=0
set NEED_NODE=0
set NEED_NODE_UPGRADE=0
set NEED_AE=0
set NEED_PDM=0
set NEED_MODULES=0
set NEED_FFMPEG=0

:: ============================================
:: 1. Node.js
:: ============================================
call :Step 1 7 "Node.js"

set BUNDLED_NODE=!REPO_ROOT!\vendor\node\node.exe
set NODE_FROM=Bundled

if exist "!BUNDLED_NODE!" (
    set NODE_SIZE=0
    for %%s in ("!BUNDLED_NODE!") do set NODE_SIZE=%%~zs
    if !NODE_SIZE! lss 1048576 (
        echo   [WARN] node.exe is an LFS pointer ^(!NODE_SIZE! bytes^) - auto-fix will download it
        set NEED_NODE=1
    ) else (
        for /f "delims=" %%i in ('""!BUNDLED_NODE!" -v 2^>nul"') do set NODE_VER=%%i
        echo   [OK] Node.js ^(bundled^) -- !NODE_VER!
        set /a PASS+=2
    )
) else (
    where node >nul 2>nul
    if !errorlevel!==0 (
        for /f "delims=" %%i in ('node -v 2^>nul') do set NODE_VER=%%i
        echo   [OK] Node.js installed -- !NODE_VER!
        set /a PASS+=1

        rem Minimum 20.18 -- same baseline as package.json engines; strip the leading v.
        rem Split on '.' with tokens=1,2 to get the major and minor numbers.
        rem Pass when major is above 20, or major equals 20 with minor 18 or higher.
        set "NODE_VER_OK="
        for /f "tokens=1,2 delims=." %%a in ("!NODE_VER:v=!") do (
            if %%a gtr 20 set "NODE_VER_OK=1"
            if %%a equ 20 if %%b geq 18 set "NODE_VER_OK=1"
        )
        if defined NODE_VER_OK (
            echo   [OK] Node.js version ^>= 20.18
            set /a PASS+=1
        ) else (
            echo   [FAIL] Node.js version ^>= 20.18 -- current !NODE_VER!
            set /a FAIL+=1
            set NEED_NODE_UPGRADE=1
        )
    ) else (
        echo   [WARN] Node.js not installed -- install.bat fetches a bundled one; source clones need Node ^>= 20.18
        set NEED_NODE=1
    )
)

where npm >nul 2>nul
if !errorlevel!==0 (
    for /f "delims=" %%i in ('npm -v 2^>nul') do set NPM_VER=%%i
    echo   [OK] npm available -- !NPM_VER!
    set /a PASS+=1
) else (
    echo   [WARN] npm not found ^(bundled with Node.js^)
)

echo.

:: ============================================
:: 2. After Effects
:: ============================================
call :Step 2 7 "After Effects"

set AE_FOUND=0
set AE_VER=
set AE_PATH=
set AE_BEST_MAJOR=0
set AE_KEY_COUNT=0
set AE_OLD_COUNT=0
set "AE_OLD_LIST="

:: Same criteria as install.bat: enumerate major.0 subkeys under HKLM\SOFTWARE\Adobe\After Effects.
:: A major below 23 counts as legacy; AS_ExtP requires AE 2023 / 23.0+ and install.bat skips older versions.
:: Found means major 23 or higher with a readable InstallPath; the highest major wins, since registry order is lexicographic.
:: Product year = major + 2000. A missing AfterFX.exe is only a stale-entry warning and does not change the result.
for /f "delims=" %%k in ('reg query "HKLM\SOFTWARE\Adobe\After Effects" 2^>nul ^| findstr /R /C:"\\[0-9][0-9]*\.0$"') do (
    set "AE_MAJOR="
    for /f "delims=." %%v in ("%%~nxk") do set "AE_MAJOR=%%v"
    if defined AE_MAJOR (
        reg query "HKLM\SOFTWARE\Adobe\After Effects\!AE_MAJOR!.0" /v InstallPath >nul 2>nul
        if !errorlevel!==0 (
            if !AE_MAJOR! LSS 23 (
                set /a AE_OLD_COUNT+=1
                set "AE_OLD_LIST=!AE_OLD_LIST!!AE_MAJOR!.0 "
            ) else (
                set /a AE_KEY_COUNT+=1
                set "AE_PATH_THIS="
                for /f "tokens=2,*" %%p in ('reg query "HKLM\SOFTWARE\Adobe\After Effects\!AE_MAJOR!.0" /v InstallPath 2^>nul ^| findstr InstallPath') do set "AE_PATH_THIS=%%q"
                if defined AE_PATH_THIS (
                    if !AE_MAJOR! GTR !AE_BEST_MAJOR! (
                        set "AE_BEST_MAJOR=!AE_MAJOR!"
                        set /a "AE_VER=!AE_MAJOR!+2000"
                        set "AE_PATH=!AE_PATH_THIS!"
                        set AE_FOUND=1
                    )
                )
            )
        )
    )
)

if !AE_FOUND!==1 (
    echo   [OK] After Effects !AE_VER! -- !AE_PATH!
    set /a PASS+=1
    if not exist "!AE_PATH!\AfterFX.exe" (
        echo   [WARN] no AfterFX.exe under that path -- stale registry entry? install.bat skips its .aex deploy
    )
) else (
    if !AE_KEY_COUNT! NEQ 0 (
        echo   [WARN] !AE_KEY_COUNT! AE 2023+ key^(s^) found but InstallPath unreadable
        echo          install.bat continues without .aex deploy / PlayerDebugMode for them
    ) else (
        if !AE_OLD_COUNT! NEQ 0 (
            echo   [FAIL] No supported After Effects -- need AE 2023 ^(23.0^) or newer; found only: !AE_OLD_LIST!
            set /a FAIL+=1
            set NEED_AE=1
        ) else (
            echo   [FAIL] After Effects not found -- AE 2023 ^(23.0^) or newer required
            set /a FAIL+=1
            set NEED_AE=1
        )
    )
)

:: Map AE year to CSXS version
set CSXS_VER=11
if !AE_FOUND!==1 (
    if !AE_VER! geq 2025 set CSXS_VER=12
    if !AE_VER!==2023 set CSXS_VER=11
    if !AE_VER!==2022 set CSXS_VER=10
    if !AE_VER!==2021 set CSXS_VER=9
    if !AE_VER!==2020 set CSXS_VER=8
)

echo.

:: ============================================
:: 3. PlayerDebugMode (only if AE found)
:: ============================================
if !AE_FOUND!==1 (
    call :Step 3 7 "PlayerDebugMode / Registry"

    set PDM_OK=0

    call :CheckPDM "HKCU\SOFTWARE\Adobe\CSXS.!CSXS_VER!" HKCU

    if !PDM_OK!==0 (
        call :CheckPDM "HKLM\SOFTWARE\Adobe\CSXS.!CSXS_VER!" HKLM
    )

    if !PDM_OK!==0 (
        echo   [FAIL] PlayerDebugMode not set -- CSXS.!CSXS_VER!
        set /a FAIL+=1
        set NEED_PDM=1
    )
    echo.
    goto :PdmDone
)
echo   [SKIP] PlayerDebugMode -- AE not detected, cannot determine CSXS version
echo.

:PdmDone

goto :PdmSkipDone

:CheckPDM
set "PDM_KEY=%~1"
set "PDM_SRC=%~2"
reg query "!PDM_KEY!" /v PlayerDebugMode >nul 2>nul
if !errorlevel! neq 0 exit /b 0
for /f "tokens=3" %%r in ('reg query "!PDM_KEY!" /v PlayerDebugMode 2^>nul ^| findstr PlayerDebugMode') do (
    if "%%r"=="1"   set PDM_OK=1
    if "%%r"=="0x1" set PDM_OK=1
)
if !PDM_OK!==1 (
    echo   [OK] PlayerDebugMode / !PDM_SRC! -- CSXS.!CSXS_VER!
    set /a PASS+=1
)
exit /b 0

:PdmSkipDone

:: ============================================
:: 4. AE Preferences
:: ============================================
call :Step 4 7 "AE Preferences"
echo   [??] Allow scripts to write files and access network
echo        AE ^> Edit ^> Preferences ^> Scripting ^& Expressions
echo.
echo        *** MUST enable this or the extension cannot work ***
echo.

:: ============================================
:: 5. ffmpeg
:: ============================================
call :Step 5 7 "ffmpeg"

set FFMPEG_OK=0
set FFMPEG_FROM=

:: 5a. bundled ffmpeg
if exist "!REPO_ROOT!\vendor\ffmpeg\ffmpeg.exe" (
    set FF_SIZE=0
    for %%s in ("!REPO_ROOT!\vendor\ffmpeg\ffmpeg.exe") do set FF_SIZE=%%~zs
    if !FF_SIZE! lss 1048576 (
        echo   [WARN] ffmpeg.exe is an LFS pointer ^(!FF_SIZE! bytes^) - auto-fix will download it
        set NEED_FFMPEG=1
    ) else (
        for /f "delims=" %%i in ('""!REPO_ROOT!\vendor\ffmpeg\ffmpeg.exe" -version 2^>nul ^| findstr /C:"ffmpeg version""') do set FFMPEG_VER=%%i
        echo   [OK] ffmpeg ^(bundled^) -- !FFMPEG_VER!
        set /a PASS+=1
        set FFMPEG_OK=1
        set FFMPEG_FROM=bundled
    )
)

if !FFMPEG_OK!==0 (
    where ffmpeg >nul 2>nul
    if !errorlevel!==0 (
        for /f "delims=" %%i in ('ffmpeg -version 2^>nul ^| findstr /C:"ffmpeg version"') do set FFMPEG_VER=%%i
        echo   [OK] ffmpeg ^(system^) -- !FFMPEG_VER!
        set /a PASS+=1
        set FFMPEG_OK=1
        set FFMPEG_FROM=system
    ) else (
        echo   [WARN] ffmpeg not found -- mov-^>webm transcode unavailable ^(optional; auto-fix can download it^)
        set NEED_FFMPEG=1
    )
)

:: ffprobe (always alongside ffmpeg)
if !FFMPEG_OK!==1 (
    if "!FFMPEG_FROM!"=="bundled" (
        if exist "!REPO_ROOT!\vendor\ffmpeg\ffprobe.exe" (
            echo   [OK] ffprobe ^(bundled^)
            set /a PASS+=1
        ) else (
            echo   [WARN] ffprobe missing -- transcode progress unavailable
        )
    ) else (
        where ffprobe >nul 2>nul
        if !errorlevel!==0 (
            echo   [OK] ffprobe ^(system^)
            set /a PASS+=1
        ) else (
            echo   [WARN] ffprobe not found -- transcode progress unavailable
        )
    )
) else (
    rem Without ffmpeg ffprobe cannot pass either, so skip silently
)

echo.

:: ============================================
:: 6. Project Dependencies
:: ============================================
call :Step 6 7 "Project Dependencies"

if exist "!REPO_ROOT!\package.json" (
    if exist "!REPO_ROOT!\node_modules\" (
        echo   [OK] node_modules installed
        set /a PASS+=1
    ) else (
        echo   [WARN] node_modules not installed -- install.bat / deploy.bat copy vendor\node_modules; auto-fix can npm install
        set NEED_MODULES=1
    )
) else (
    echo   [WARN] package.json not found -- !REPO_ROOT!
)

echo.

:: ============================================
:: 7. System (disk / network) -- same criteria as install.bat
:: ============================================
call :Step 7 7 "System"

for %%d in ("%TEMP%") do set "TEMP_DRIVE=%%~dd"
for /f %%d in ('powershell -Command "[math]::Round((Get-PSDrive -Name '!TEMP_DRIVE:~0,1!').Free/1GB)" 2^>nul') do set DISK_FREE_GB=%%d
if defined DISK_FREE_GB (
    if !DISK_FREE_GB! lss 1 (
        echo   [FAIL] !TEMP_DRIVE! drive only !DISK_FREE_GB! GB free - install.bat refuses to run without ^>1 GB
        set /a FAIL+=1
    ) else (
        if !DISK_FREE_GB! lss 3 (
            echo   [WARN] !TEMP_DRIVE! drive only !DISK_FREE_GB! GB free - install may run out of space
        ) else (
            echo   [OK]  Disk space !DISK_FREE_GB! GB free on !TEMP_DRIVE!
            set /a PASS+=1
        )
    )
) else (
    echo   [??]  Could not check disk space
)

curl.exe -sI --connect-timeout 5 "https://github.com" >nul 2>nul
if !errorlevel!==0 (
    echo   [OK] Network reachable ^(github.com^)
    set /a PASS+=1
) else (
    echo   [WARN] github.com unreachable - install.bat downloads may fail
)

echo.

:: ============================================
:: Results
:: ============================================
set /a TOTAL=%PASS%+%FAIL%
echo ========================================
echo   Result: %PASS% / %TOTAL% passed
echo ========================================
echo.

:: Continue only when there is a FAIL or an auto-fixable missing item; Ready means all OK and nothing missing
set NEED_TOTAL=0
if !NEED_NODE!==1         set /a NEED_TOTAL+=1
if !NEED_NODE_UPGRADE!==1 set /a NEED_TOTAL+=1
if !NEED_PDM!==1          set /a NEED_TOTAL+=1
if !NEED_MODULES!==1      set /a NEED_TOTAL+=1
if !NEED_FFMPEG!==1       set /a NEED_TOTAL+=1
if !NEED_AE!==1           set /a NEED_TOTAL+=1

if %FAIL%==0 if !NEED_TOTAL!==0 (
    echo   All checks passed. Ready to use AS_ExtP!
    goto :EOF
)

:: ============================================
:: Auto-fix
:: ============================================

set CAN_AUTO=0
if !NEED_NODE!==1         set /a CAN_AUTO+=1
if !NEED_NODE_UPGRADE!==1 set /a CAN_AUTO+=1
if !NEED_PDM!==1          set /a CAN_AUTO+=1
if !NEED_MODULES!==1      set /a CAN_AUTO+=1
if !NEED_FFMPEG!==1       set /a CAN_AUTO+=1

set MANUAL=0
if !NEED_AE!==1           set /a MANUAL+=1

echo !CAN_AUTO! item(s) can be auto-fixed, !MANUAL! need(s) manual action
echo.

if !CAN_AUTO! gtr 0 (
    set /p DO_ALL="Fix all automatically? (Y/N): "
    echo.
    if /i "!DO_ALL!"=="Y" goto :DoFix
    echo Auto-fix skipped.
    goto :ManualFix
)
goto :ManualFix

:DoFix
echo ========================================
echo   Fixing...
echo ========================================
echo.

:: --- Node.js (download to vendor\) ---
if !NEED_NODE!==1 (
    echo [Fix] Downloading Node.js v22.23.2 to vendor\node\...
    rem Pin the zip SHA256: official nodejs.org value; npmmirror serves the same zip, so both sources share it
    set "DL_EXPECTED_SHA256=1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
    set "DL_URL=https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip"
    set "DL_FILE=%TEMP%\node-v22.23.2-win-x64.zip"
    call :DownloadFile
    if !DL_OK!==0 (
        echo   [Mirror] Trying npmmirror.com...
        set "DL_URL=https://npmmirror.com/mirrors/node/v22.23.2/node-v22.23.2-win-x64.zip"
        set "DL_FILE=%TEMP%\node-v22.23.2-win-x64.zip"
        call :DownloadFile
    )
    if !DL_OK!==1 (
        echo   Extracting...
        powershell -Command "Expand-Archive -Path '!DL_FILE!' -DestinationPath '%TEMP%\node-tmp' -Force"
        if not exist "!REPO_ROOT!\vendor\node" mkdir "!REPO_ROOT!\vendor\node"
        copy /Y "%TEMP%\node-tmp\node-v22.23.2-win-x64\node.exe" "!REPO_ROOT!\vendor\node\node.exe" >nul
        if exist "%TEMP%\node-tmp\node-v22.23.2-win-x64\LICENSE" copy /Y "%TEMP%\node-tmp\node-v22.23.2-win-x64\LICENSE" "!REPO_ROOT!\vendor\node\LICENSE" >nul
        del "!DL_FILE!" 2>nul
        rmdir /S /Q "%TEMP%\node-tmp" 2>nul
        if exist "!REPO_ROOT!\vendor\node\node.exe" (
            echo   [OK] Node.js v22.23.2 installed to vendor\node\
            set NEED_NODE=0
        ) else (
            echo   [FAIL] Extraction failed
        )
    ) else (
        echo   [FAIL] All download methods failed. Install manually: https://nodejs.org/
    )
    echo.
)

:: --- Node.js upgrade ---
if !NEED_NODE_UPGRADE!==1 (
    echo [Fix] Upgrading Node.js...
    where winget >nul 2>nul
    if !errorlevel!==0 (
        echo   Upgrading via winget...
        winget upgrade OpenJS.NodeJS --accept-package-agreements --silent
        if !errorlevel!==0 (
            echo   [OK] Node.js upgraded
            set /a FAIL-=1
            set NEED_NODE_UPGRADE=0
        ) else (
            echo   Upgrade failed, trying reinstall...
            winget install OpenJS.NodeJS.LTS --accept-package-agreements --force --silent
            if !errorlevel!==0 (
                echo   [OK] Node.js reinstalled
                set /a FAIL-=1
                set NEED_NODE_UPGRADE=0
            ) else (
                echo   [FAIL] Auto-upgrade failed
            )
        )
    ) else (
        start "" "https://nodejs.org/dist/v22.23.2/node-v22.23.2-x64.msi"
        echo   Download page opened. Please install manually.
    )
    echo.
)

:: --- PlayerDebugMode ---
if !NEED_PDM!==1 (
    echo [Fix] Setting PlayerDebugMode...
    reg add "HKCU\SOFTWARE\Adobe\CSXS.!CSXS_VER!" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>nul
    if !errorlevel!==0 (
        echo   [OK] PlayerDebugMode set -- HKCU\SOFTWARE\Adobe\CSXS.!CSXS_VER!
        set /a FAIL-=1
        set NEED_PDM=0
    ) else (
        echo   [FAIL] Permission denied. Run as administrator or set manually:
        echo   reg add "HKCU\SOFTWARE\Adobe\CSXS.!CSXS_VER!" /v PlayerDebugMode /t REG_SZ /d 1 /f
    )
    echo.
)

:: --- npm dependencies (full install incl. devDependencies: lint and both audits need eslint) ---
if !NEED_MODULES!==1 (
    echo [Fix] Installing npm dependencies...
    where npm >nul 2>nul
    if !errorlevel!==0 (
        pushd "!REPO_ROOT!"
        rem npm ci first, same as DEVELOPMENT.md and CI: reproduce from the lockfile; fall back to npm install on failure
        echo   Running npm ci...
        call npm ci
        if !errorlevel! NEQ 0 (
            echo   npm ci failed - falling back to npm install...
            call npm install
        )
        if !errorlevel!==0 (
            echo   [OK] npm dependencies installed ^(incl. devDependencies^)
            set NEED_MODULES=0
        ) else (
            echo   [FAIL] npm install failed. Check network and try manually.
        )
        popd
    ) else (
        echo   [SKIP] npm not available ^(install Node.js first^)
    )
    echo.
)

:: --- ffmpeg (download to vendor\) ---
if !NEED_FFMPEG!==1 (
    echo [Fix] Downloading ffmpeg 8.1.2 to vendor\ffmpeg\...
    rem Fixed GitHub Release only with a pinned SHA256; rolling gyan.dev builds have no fixed hash
    set "DL_URL=https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip"
    set "DL_FILE=%TEMP%\ffmpeg-8.1.2-essentials_build.zip"
    set "DL_EXPECTED_SHA256=db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec"
    call :DownloadFile
    if !DL_OK!==1 (
        echo   Extracting...
        powershell -Command "Expand-Archive -Path '!DL_FILE!' -DestinationPath '%TEMP%\ffmpeg-tmp' -Force"
        for /d %%d in ("%TEMP%\ffmpeg-tmp\ffmpeg-*") do set "FF_ROOT=%%d"
        for /d %%d in ("%TEMP%\ffmpeg-tmp\ffmpeg-*") do set "FF_SRC=%%d\bin"
        if not exist "!REPO_ROOT!\vendor\ffmpeg" mkdir "!REPO_ROOT!\vendor\ffmpeg"
        copy /Y "!FF_SRC!\ffmpeg.exe" "!REPO_ROOT!\vendor\ffmpeg\ffmpeg.exe" >nul 2>nul
        copy /Y "!FF_SRC!\ffprobe.exe" "!REPO_ROOT!\vendor\ffmpeg\ffprobe.exe" >nul 2>nul
        for %%n in (LICENSE LICENSE.md COPYING.GPLv3 COPYING.GPLv2 COPYING.LGPLv2.1 COPYING.LGPLv3) do (
            if exist "!FF_ROOT!\%%n" copy /Y "!FF_ROOT!\%%n" "!REPO_ROOT!\vendor\ffmpeg\%%n" >nul 2>nul
        )
        > "!REPO_ROOT!\vendor\ffmpeg\SOURCE.txt" echo FFmpeg 8.1.2-essentials_build ^(GPL-3.0-or-later^)
        >> "!REPO_ROOT!\vendor\ffmpeg\SOURCE.txt" echo URL: https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip
        >> "!REPO_ROOT!\vendor\ffmpeg\SOURCE.txt" echo SHA-256: db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec
        >> "!REPO_ROOT!\vendor\ffmpeg\SOURCE.txt" echo Source: https://ffmpeg.org/download.html#releases ^(ffmpeg-8.1.2.tar.xz^)
        >> "!REPO_ROOT!\vendor\ffmpeg\SOURCE.txt" echo Upstream commit: 38b88335f9
        del "!DL_FILE!" 2>nul
        rmdir /S /Q "%TEMP%\ffmpeg-tmp" 2>nul
        if exist "!REPO_ROOT!\vendor\ffmpeg\ffmpeg.exe" (
            echo   [OK] ffmpeg + ffprobe installed to vendor\ffmpeg\
            echo   [NOTE] FFmpeg is GPL-3.0-or-later - license texts kept in vendor\ffmpeg\
            set NEED_FFMPEG=0
        ) else (
            echo   [FAIL] Extraction failed
        )
    ) else (
        echo   [FAIL] All download methods failed. Download manually:
        rem Manual download points at the same fixed Release tag as the automatic download
        echo   https://github.com/GyanD/codexffmpeg/releases/tag/8.1.2
        echo   Extract ffmpeg.exe + ffprobe.exe to: vendor\ffmpeg\
    )
    echo.
)

echo ========================================
echo   Auto-fix complete
echo ========================================
echo.

:: ============================================
:: Manual items
:: ============================================
:ManualFix

set REMAIN=0
if !NEED_NODE!==1         set /a REMAIN+=1
if !NEED_NODE_UPGRADE!==1 set /a REMAIN+=1
if !NEED_AE!==1           set /a REMAIN+=1
if !NEED_PDM!==1          set /a REMAIN+=1
if !NEED_MODULES!==1      set /a REMAIN+=1
if !NEED_FFMPEG!==1       set /a REMAIN+=1

if %REMAIN%==0 (
    echo All issues fixed!
    echo.
    set /p RERUN="Re-check? (Y/N): "
    if /i "!RERUN!"=="Y" (
        echo.
        call "%~f0"
    )
    goto :EOF
)

echo Manual actions needed:
echo.

if !NEED_NODE!==1 (
    echo   * Node.js not installed
    echo     Download: https://nodejs.org/ ^(LTS, ^>=20.18^)
    echo.
)
if !NEED_NODE_UPGRADE!==1 (
    echo   * Node.js version too old ^(!NODE_VER!^)
    echo     Download: https://nodejs.org/
    echo.
)
if !NEED_AE!==1 (
    echo   * After Effects 2023 ^(23.0^) or newer not found
    echo     Install AE 2023+ first; install.bat refuses to run on older versions
    echo.
)
if !NEED_PDM!==1 (
    echo   * PlayerDebugMode not set
    echo     reg add "HKCU\SOFTWARE\Adobe\CSXS.!CSXS_VER!" /v PlayerDebugMode /t REG_SZ /d 1 /f
    echo.
)
if !NEED_MODULES!==1 (
    echo   * node_modules not installed
    echo     cd /d "!REPO_ROOT!"
    echo     npm ci    ^(fallback: npm install^)
    echo.
)
if !NEED_FFMPEG!==1 (
    echo   * ffmpeg not found ^(needed for mov-^>webm transcoding^)
    rem Same fixed Release tag as the automatic download source
    echo     Download: https://github.com/GyanD/codexffmpeg/releases/tag/8.1.2
    echo     Extract ffmpeg.exe + ffprobe.exe to: vendor\ffmpeg\
    echo.
)

echo   * AE Preferences (manual check)
echo     AE ^> Edit ^> Preferences ^> Scripting ^& Expressions
echo     Enable "Allow Scripts to Write Files and Access Network"
echo.

echo Re-run this script after fixing the above.
goto :EOF

:: ============================================
:: Download helper -- three fallbacks, resume, pinned SHA256 check
:: Caller sets DL_URL / DL_FILE / DL_EXPECTED_SHA256 and checks DL_OK on return (1 = success)
:: SHA256 is the only integrity criterion: a mismatch deletes the file and moves on to the next method or source
:: ============================================
:DownloadFile
set DL_OK=0

:: Hash an existing file first; skip only on a match, otherwise delete and download again
if exist "!DL_FILE!" if not "!DL_FILE!"=="" (
    call :VerifySha256
    if "!DL_HASH_OK!"=="1" (
        set DL_OK=1
    ) else (
        echo   [WARN] Existing file failed SHA256 check - deleting: !DL_FILE!
        del "!DL_FILE!" 2>nul
    )
)
if !DL_OK!==1 exit /b

:: Resume: continue an existing partial file with curl -C
:: The hash gate above deletes every mismatched file, so this branch is only a fallback
if exist "!DL_FILE!" (
    for %%f in ("!DL_FILE!") do set DL_PARTIAL=%%~zf
    if !DL_PARTIAL! gtr 0 (
        echo   [0/3] Resuming partial download ^(!DL_PARTIAL! bytes^)...
        curl.exe -# -L -C - -o "!DL_FILE!" "!DL_URL!" 2>&1
        call :HashGate
    )
    if !DL_OK!==0 del "!DL_FILE!" 2>nul
)

if !DL_OK!==0 (
    echo   [1/3] Trying curl...
    curl.exe -# -L -C - -o "!DL_FILE!" "!DL_URL!" 2>&1
    call :HashGate
)

if !DL_OK!==0 (
    echo   [2/3] Trying PowerShell...
    powershell -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -Uri '!DL_URL!' -OutFile '!DL_FILE!' -UseBasicParsing } catch { exit 1 }" 2>nul
    call :HashGate
)

if !DL_OK!==0 (
    echo   [3/3] Trying certutil...
    certutil -urlcache -split -f "!DL_URL!" "!DL_FILE!" >nul 2>nul
    call :HashGate
)

if !DL_OK!==1 (
    for %%f in ("!DL_FILE!") do echo   [OK] Downloaded %%~zf bytes, SHA256 verified
) else (
    echo   [FAIL] All methods failed
)
exit /b

:: ============================================
:: Hash gate for files above the size floor -- set DL_OK=1 on a match; delete the file and keep 0 otherwise
:: ============================================
:HashGate
if not exist "!DL_FILE!" exit /b
for %%f in ("!DL_FILE!") do if %%~zf leq 1024 exit /b
call :VerifySha256
if "!DL_HASH_OK!"=="1" (
    set DL_OK=1
) else (
    echo   [FAIL] SHA256 mismatch ^(got !DL_ACTUAL!^) - file deleted, trying next method/source
    del "!DL_FILE!" 2>nul
)
exit /b

:: ============================================
:: Compute DL_FILE SHA256 with certutil and compare it with DL_EXPECTED_SHA256
:: Result: DL_HASH_OK=1 on a match, 0 otherwise; DL_ACTUAL holds the computed hash
:: ============================================
:VerifySha256
set DL_HASH_OK=0
set "DL_ACTUAL="
if not exist "!DL_FILE!" exit /b
:: Line 2 of certutil output is the hash; strip spaces to accept the legacy grouped format
for /f "skip=1 delims=" %%h in ('certutil -hashfile "!DL_FILE!" SHA256 2^>nul') do if not defined DL_ACTUAL set "DL_ACTUAL=%%h"
if not defined DL_ACTUAL exit /b
set "DL_ACTUAL=!DL_ACTUAL: =!"
if /I "!DL_ACTUAL!"=="!DL_EXPECTED_SHA256!" set DL_HASH_OK=1
exit /b

:: ============================================
:: Step indicator -- "[3/6] [###.......] Title"
:: ASCII only (console runs under chcp 437)
:: ============================================
:Step
set "SP_CUR=%~1"
set "SP_TOT=%~2"
set "SP_TITLE=%~3"
call :StepBar %~1 %~2
echo [%SP_CUR%/%SP_TOT%] [!SP_BAR!] %SP_TITLE%
exit /b

:StepBar
set "SP_BAR="
set /a "SP_FILL=(%~1*10)/%~2"
for /l %%i in (1,1,10) do (
    if %%i leq !SP_FILL! (
        set "SP_BAR=!SP_BAR!#"
    ) else (
        set "SP_BAR=!SP_BAR!."
    )
)
exit /b
