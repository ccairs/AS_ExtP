@echo off
chcp 437 >nul 2>nul
setlocal enabledelayedexpansion
title AS_ExtP One-Click Install

:: ============================================
::  AS_ExtP one-click installer
::  Usage: right-click -> Run as administrator
::  Actions: download -> add vendor binaries -> deploy to the AE extensions folder
::  Requires: After Effects 2023 (23.0) or newer (CEP 11 / CSXS.11)
::  Output: console prints ASCII English only (chcp 437); this script is ASCII only
:: ============================================

:: -- Administrator rights --
net session >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Requesting admin rights...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:: Temp directory name has a random suffix so an unprivileged process cannot pre-create a fixed-name junction
set "TEMP_DIR=%TEMP%\as_extp_install_%RANDOM%%RANDOM%%RANDOM%"
set "DEST=C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\AS_ExtP"

:: -- Repository URLs --
set "REPO_ZIP_URL=https://github.com/ccairs/AS_ExtP/archive/refs/heads/main.zip"
set "REPO_GIT_URL=https://github.com/ccairs/AS_ExtP.git"
set "NODE_URL=https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip"
set "NODE_MIRROR=https://npmmirror.com/mirrors/node/v22.23.2/node-v22.23.2-win-x64.zip"
:: Primary GitHub Release asset plus two third-party GitHub mirrors of the same asset.
:: The pinned SHA256 below is the only integrity test, so a mirror cannot substitute a different file.
set "FFMPEG_URL=https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip"
set "FFMPEG_MIRROR=https://gh-proxy.com/https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip"
set "FFMPEG_MIRROR2=https://ghfast.top/https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip"
set "FFMPEG_SRC_1=%FFMPEG_URL%"
set "FFMPEG_SRC_2=%FFMPEG_MIRROR%"
set "FFMPEG_SRC_3=%FFMPEG_MIRROR2%"

:: -- Pinned download hashes (SHA256) --
:: Value from the official nodejs.org SHASUMS256.txt; the npmmirror copy distributes the same zip, so the hash matches
set "NODE_SHA256=1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
:: Fixed asset ffmpeg-8.1.2-essentials_build.zip from the GitHub GyanD/codexffmpeg release 8.1.2
set "FFMPEG_SHA256=db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec"
:: The repo tracks a moving branch, so no hash is pinned here. Set the official SHA256 to enforce verification; empty means a prominent warning after download
set "EXPECTED_REPO_SHA256="

:: -- Safety gates --
set "DEST_END=!DEST:~-8!"
if /I not "!DEST_END!"=="\AS_ExtP" (
    echo [ERROR] Invalid DEST: !DEST!
    pause & exit /b 1
)

echo.
echo ========================================
echo   AS_ExtP One-Click Install
echo ========================================
echo.
echo   This will:
echo   1. Download AS_ExtP from GitHub
echo   2. Download Node.js + ffmpeg (^~140MB total^)
echo   3. Deploy to AE extensions
echo.
echo   Dest: !DEST!
echo.

choice /C YN /N /M "Continue? (Y/N): "
if errorlevel 2 exit /b
echo.

:: -- Pre-flight checks --
echo ========================================
echo   Pre-flight checks
echo ========================================
echo.

:: AE process
tasklist /FI "IMAGENAME eq AfterFX.exe" 2>nul | findstr AfterFX >nul
if %errorlevel%==0 (
    echo   [!] After Effects is running.
    echo   [!] Deploying while AE is open may cause file locks.
    echo.
    choice /C YN /N /M "      Continue anyway? (Y/N): "
    if errorlevel 2 exit /b
    echo.
)

:: AE registry
:: Minimum supported version is AE 2023 (23.0, CEP 11 / Chrome 88). Older AE only reports [SKIP],
::     no panel deploy, no PlayerDebugMode write and no .aex deploy.
:: Record every supported installed AE version as AE_INSTALL_<major>=install path,
::     so multi-version machines get the panel and .aex deployed for each version.
::     The major version is the registry key name (23.0 = AE 2023); 19/20/21 never existed for AE.
::     AE_INSTALL (path of the highest supported version) is kept as a compatibility variable.
:: Three "AE not found" cases:
::   (a) no AE version key at all (AE_KEY_COUNT=0) -> [FAIL] + exit /b 1;
::   (b) supported AE keys exist but every InstallPath failed to resolve (AE_KEY_COUNT>0, AE_COUNT=0) ->
::       do not abort: print [WARN] and continue the remaining steps; those versions are skipped
::       (the deploy and registry loops below require AE_INSTALL_<m> to be defined) and the summary reports it.
::   (c) only AE versions below the minimum (AE_OLD_COUNT>0, AE_COUNT=0) -> [FAIL] + exit /b 1:
::       the panel does not run on them, so no deploy and no registry write is attempted;
::       only the skipped versions are reported.
set "MIN_AE_VER=23"
set AE_COUNT=0
set AE_KEY_COUNT=0
set AE_OLD_COUNT=0
set "AE_OLD_LIST="
set "AE_INSTALL="
set "AE_MAJOR_LIST="
set "AE_MAX_MAJOR="
:: Enumerate the AE registry subkeys instead of hardcoding a version list.
:: A hardcoded list misses AE releases newer than the list and sends a machine that
:: only has such a version to the (a) branch [FAIL] After Effects not found + exit /b 1.
:: The major version is the numeric part of the "<n>.0" subkey name; the numeric max is tracked separately.
for /f "delims=" %%k in ('reg query "HKLM\SOFTWARE\Adobe\After Effects" 2^>nul ^| findstr /R /C:"\\[0-9][0-9]*\.0$"') do (
    set "AE_MAJOR="
    for /f "delims=." %%v in ("%%~nxk") do set "AE_MAJOR=%%v"
    if defined AE_MAJOR (
        reg query "HKLM\SOFTWARE\Adobe\After Effects\!AE_MAJOR!.0" /v InstallPath >nul 2>nul
        if !errorlevel!==0 (
            if !AE_MAJOR! LSS !MIN_AE_VER! (
                set /a AE_OLD_COUNT+=1
                set "AE_OLD_LIST=!AE_OLD_LIST!!AE_MAJOR!.0 "
                echo   [SKIP] After Effects !AE_MAJOR!.0 - below AS_ExtP minimum ^(AE 2023 / 23.0^), skipped
            ) else (
                set /a AE_KEY_COUNT+=1
                set "AE_INSTALL_THIS="
                for /f "tokens=2,*" %%a in ('reg query "HKLM\SOFTWARE\Adobe\After Effects\!AE_MAJOR!.0" /v InstallPath 2^>nul ^| findstr InstallPath') do set "AE_INSTALL_THIS=%%b"
                if defined AE_INSTALL_THIS (
                    set /a AE_COUNT+=1
                    set "AE_INSTALL_!AE_MAJOR!=!AE_INSTALL_THIS!"
                    set "AE_MAJOR_LIST=!AE_MAJOR_LIST! !AE_MAJOR!"
                    if not defined AE_MAX_MAJOR set "AE_MAX_MAJOR=!AE_MAJOR!"
                    if !AE_MAJOR! GTR !AE_MAX_MAJOR! set "AE_MAX_MAJOR=!AE_MAJOR!"
                    echo   [OK] After Effects !AE_MAJOR!.0
                ) else (
                    echo   [WARN] After Effects !AE_MAJOR!.0 detected but InstallPath unreadable
                    echo          Its Plug-ins ^(.aex^) deploy and PlayerDebugMode are skipped - handle manually.
                )
            )
        )
    )
)
:: AE_INSTALL keeps the highest supported version path as a compatibility variable (enumeration order is not version order, so the numeric max is used)
if defined AE_MAX_MAJOR for %%x in (!AE_MAX_MAJOR!) do set "AE_INSTALL=!AE_INSTALL_%%x!"
if !AE_COUNT!==0 (
    if !AE_KEY_COUNT! NEQ 0 (
        echo   [WARN] !AE_KEY_COUNT! supported AE version^(s^) detected but no install path resolved
        echo          Continuing install; their Plug-ins ^(.aex^) deploy and PlayerDebugMode
        echo          are skipped. Fix the registry InstallPath, then re-run for those versions.
    ) else if !AE_OLD_COUNT! NEQ 0 (
        echo   [FAIL] No supported After Effects version found
        echo          AS_ExtP requires AE 2023 ^(23.0^) or newer; skipped: !AE_OLD_LIST!
        echo          Upgrade After Effects, then re-run.
        pause
        exit /b 1
    ) else (
        echo   [FAIL] After Effects not found
        echo.
        echo   AE 2023+ required. Install AE first, then re-run.
        pause
        exit /b 1
    )
)
if !AE_COUNT! GTR 1 echo   [OK] !AE_COUNT! supported AE versions detected - deploying to all

:: PlayerDebugMode: every CSXS.N key is checked individually because all Adobe CEP hosts share them;
:: a missing flag on any checked key is reported [WARN] instead of a single [OK]
set PDM_OK=1
set PDM_ANY=0
:: Minimum host is AE 2023 (CSXS.11/12); older CSXS.8-10 (AE 2020 and below) are not checked
for %%v in (12 11) do (
    reg query "HKCU\SOFTWARE\Adobe\CSXS.%%v" >nul 2>nul
    if !errorlevel!==0 (
        set PDM_ANY=1
        set "PDM_ONE=0"
        for /f "tokens=3" %%r in ('reg query "HKCU\SOFTWARE\Adobe\CSXS.%%v" /v PlayerDebugMode 2^>nul ^| findstr PlayerDebugMode') do (
            if "%%r"=="1" set "PDM_ONE=1"
            if "%%r"=="0x1" set "PDM_ONE=1"
        )
        if "!PDM_ONE!"=="0" (
            set PDM_OK=0
            echo   [WARN] PlayerDebugMode not set ^(CSXS.%%v^)
        )
    )
)
if !PDM_ANY!==0 (
    set PDM_OK=0
    echo   [WARN] No CSXS.11/12 key found - will create for detected AE versions
)
if !PDM_OK!==1 (
    echo   [OK] PlayerDebugMode
) else (
    echo   [WARN] PlayerDebugMode incomplete
    echo          Will set for every detected AE version during install...
)

:: Disk space: judged on the drive of %TEMP% (downloads and extraction both land there)
for %%d in ("%TEMP%") do set "TEMP_DRIVE=%%~dd"
for /f %%d in ('powershell -Command "[math]::Round((Get-PSDrive -Name '!TEMP_DRIVE:~0,1!').Free/1GB)" 2^>nul') do set DISK_FREE_GB=%%d
if defined DISK_FREE_GB (
    if !DISK_FREE_GB! lss 1 (
        echo   [FAIL] !TEMP_DRIVE! drive only !DISK_FREE_GB! GB free - need ^>1 GB for downloads + deploy
        pause & exit /b 1
    )
    if !DISK_FREE_GB! lss 3 (
        echo   [WARN] !TEMP_DRIVE! drive only !DISK_FREE_GB! GB free - may run out of space
    ) else (
        echo   [OK]  Disk space !DISK_FREE_GB! GB free on !TEMP_DRIVE!
    )
) else (
    echo   [??]  Could not check disk space
)

:: Network
echo   Testing network...
curl.exe -sI --connect-timeout 5 "https://github.com" >nul 2>nul
if !errorlevel!==0 (
    echo   [OK] Network reachable
) else (
    echo   [WARN] github.com pre-check failed - downloads will still be attempted
    echo          If downloads fail, check proxy / VPN / firewall settings
)

echo.

:: -- Prepare the temp dir (random name + reparse point check) --
if exist "!TEMP_DIR!" (
    rem Same-name leftovers are not expected with a random suffix, but check before delete anyway
    call :CheckNotReparse "!TEMP_DIR!"
    if "!IS_REPARSE!"=="1" (
        echo [ERROR] Temp dir is a reparse point, refusing to delete: !TEMP_DIR!
        pause & exit /b 1
    )
    rmdir /S /Q "!TEMP_DIR!" 2>nul
)
mkdir "!TEMP_DIR!" 2>nul
if not exist "!TEMP_DIR!" (
    echo [ERROR] Could not create temp dir: !TEMP_DIR!
    pause & exit /b 1
)
:: Check right after mkdir that the temp dir is not a reparse point (guards against a pre-created nested junction)
call :CheckNotReparse "!TEMP_DIR!"
if "!IS_REPARSE!"=="1" (
    echo [ERROR] Temp dir is a reparse point ^(possible junction attack^): !TEMP_DIR!
    pause & exit /b 1
)

:: ========================================
:: Step 1: Download the AS_ExtP source
:: ========================================
echo [1/5] Downloading AS_ExtP...
set "REPO_ZIP=!TEMP_DIR!\as_extp.zip"
set DL_OK=0

:: If run from inside the repository, use this copy directly
if exist "%~dp0..\host\host.jsx" if exist "%~dp0..\CSXS\manifest.xml" (
    echo   Source detected: %~dp0..
    for %%i in ("%~dp0..") do set "REPO_SRC=%%~fi"
    set DL_OK=2
    goto :step2
)

:: Pass EXPECTED_REPO_SHA256; non-empty enforces verification, empty falls back to a size check (see :CheckFile)
call :Download "!REPO_ZIP_URL!" "!REPO_ZIP!" "!EXPECTED_REPO_SHA256!"
if !DL_OK!==0 (
    echo   [FAIL] Could not download repo ^(repository URL unreachable or network issue^)
    echo.
    echo   Workarounds:
    echo   1. git clone !REPO_GIT_URL!
    echo      then run install.bat from inside the cloned folder
    echo   2. Download zip manually from GitHub, extract,
    echo      put install.bat in the extracted folder, re-run
    goto :cleanup
)
:: Warn when the hash is not pinned; set the official SHA256 to enforce verification
if "!EXPECTED_REPO_SHA256!"=="" (
    echo.
    echo   ============================================================
    echo   [WARN] REPO ZIP INTEGRITY NOT VERIFIED
    echo   [WARN] Repo tracks a moving branch - no fixed hash can be pinned.
    echo   [WARN] Paste the official SHA256 into the EXPECTED_REPO_SHA256
    echo   [WARN] variable at the top of this script and re-run to enforce it.
    echo   ============================================================
    echo.
)
echo   Extracting...
powershell -Command "Expand-Archive -Path '!REPO_ZIP!' -DestinationPath '!TEMP_DIR!\repo' -Force" 2>nul
for /d %%d in ("!TEMP_DIR!\repo\*") do set "REPO_SRC=%%~fd"
if "!REPO_SRC!"=="" (
    echo   [FAIL] Extraction failed
    goto :cleanup
)
del "!REPO_ZIP!" 2>nul

:step2
echo   [OK] Source: !REPO_SRC!

:: ========================================
:: Step 2: Download vendor binaries
:: ========================================
echo.
echo [2/5] Vendor binaries...

:: Node.js
if not exist "!REPO_SRC!\vendor\node" mkdir "!REPO_SRC!\vendor\node"
if exist "!REPO_SRC!\vendor\node\node.exe" (
    for %%s in ("!REPO_SRC!\vendor\node\node.exe") do set NODE_SIZE=%%~zs
) else (
    set NODE_SIZE=0
)
if !NODE_SIZE! lss 1048576 (
    echo   Downloading Node.js v22.23.2 ^(^~34MB^)...
    set "DL_FILE=!TEMP_DIR!\node.zip"
    rem Both sources share the same pinned hash and the same zip
    call :Download "!NODE_URL!" "!DL_FILE!" "!NODE_SHA256!"
    if !DL_OK!==0 call :Download "!NODE_MIRROR!" "!DL_FILE!" "!NODE_SHA256!"
    if !DL_OK!==1 (
        powershell -Command "Expand-Archive -Path '!DL_FILE!' -DestinationPath '!TEMP_DIR!\node-tmp' -Force"
        for /d %%d in ("!TEMP_DIR!\node-tmp\node-*") do copy /Y "%%d\node.exe" "!REPO_SRC!\vendor\node\node.exe" >nul
        for /d %%d in ("!TEMP_DIR!\node-tmp\node-*") do if exist "%%d\LICENSE" copy /Y "%%d\LICENSE" "!REPO_SRC!\vendor\node\LICENSE" >nul
        del "!DL_FILE!" 2>nul
        rem Reparse check before delete as TOCTOU guard; a hit skips the delete with a warning
        call :CheckNotReparse "!TEMP_DIR!\node-tmp"
        if "!IS_REPARSE!"=="1" (
            echo   [WARN] Skipping delete of reparse point: !TEMP_DIR!\node-tmp
        ) else (
            rmdir /S /Q "!TEMP_DIR!\node-tmp" 2>nul
        )
    )
    rem Check the size after download too; exist alone is not enough:
    rem a 133-byte git-lfs pointer satisfies exist and would be reported [OK], then
    rem host.jsx would start it with ShellExecute err=193 and the bridge never starts.
    if exist "!REPO_SRC!\vendor\node\node.exe" (
        for %%s in ("!REPO_SRC!\vendor\node\node.exe") do set NODE_SIZE2=%%~zs
    ) else (
        set NODE_SIZE2=0
    )
    if !NODE_SIZE2! lss 1048576 (
        echo   [WARN] node.exe unavailable ^(!NODE_SIZE2! bytes^) - bridge will use system Node.js
        echo          ^(possible git-lfs pointer - re-run this script, or run git lfs pull first^)
    ) else (
        for %%s in ("!REPO_SRC!\vendor\node\node.exe") do echo   [OK] node.exe %%~zs bytes
    )
) else (
    echo   [OK] node.exe already present
)

:: ffmpeg
set FF_OK=0
if not exist "!REPO_SRC!\vendor\ffmpeg" mkdir "!REPO_SRC!\vendor\ffmpeg"
if exist "!REPO_SRC!\vendor\ffmpeg\ffmpeg.exe" (
    for %%s in ("!REPO_SRC!\vendor\ffmpeg\ffmpeg.exe") do set FF_SIZE=%%~zs
) else (
    set FF_SIZE=0
)
if !FF_SIZE! lss 1048576 (
    echo   Downloading ffmpeg 8.1.2 ^(^~105MB^)...
    set "DL_FILE=!TEMP_DIR!\ffmpeg.zip"
    rem Probe each source with a 1MB range request, then try the fastest first; the pinned hash
    rem still decides integrity and the remaining sources stay as ordered fallbacks.
    set "FF_ORDER=1 2 3"
    set "FF_BEST_IDX="
    set "FF_BEST_SPEED=0"
    where curl.exe >nul 2>nul
    if !errorlevel!==0 (
        for %%i in (1 2 3) do (
            set "PROBE_SPEED="
            set "PROBE_INT="
            for /f "delims=" %%s in ('curl.exe -sL -r 0-1048575 -o NUL --connect-timeout 4 --max-time 8 --max-filesize 2097152 -w "%%{speed_download}" "!FFMPEG_SRC_%%i!" 2^>nul') do set "PROBE_SPEED=%%s"
            if defined PROBE_SPEED (
                for /f "tokens=1 delims=." %%v in ("!PROBE_SPEED!") do set "PROBE_INT=%%v"
                if defined PROBE_INT if !PROBE_INT! GTR 0 (
                    echo     [probe] source %%i: !PROBE_SPEED! B/s
                    if !PROBE_INT! GTR !FF_BEST_SPEED! (
                        set "FF_BEST_SPEED=!PROBE_INT!"
                        set "FF_BEST_IDX=%%i"
                    )
                ) else (
                    echo     [probe] source %%i: unreachable
                )
            ) else (
                echo     [probe] source %%i: unreachable
            )
        )
        if defined FF_BEST_IDX (
            echo   [OK] Fastest source: !FF_BEST_IDX! ^(!FF_BEST_SPEED! B/s^)
            set "FF_ORDER=!FF_BEST_IDX!"
            for %%i in (1 2 3) do (
                if not "%%i"=="!FF_BEST_IDX!" set "FF_ORDER=!FF_ORDER! %%i"
            )
        ) else (
            echo   [WARN] Source probe failed - using fixed order
        )
    ) else (
        echo   [WARN] curl.exe not found - source speed probe skipped
    )
    for %%o in (!FF_ORDER!) do (
        if not "!DL_OK!"=="1" call :Download "!FFMPEG_SRC_%%o!" "!DL_FILE!" "!FFMPEG_SHA256!"
    )
    if !DL_OK!==1 (
        powershell -Command "Expand-Archive -Path '!DL_FILE!' -DestinationPath '!TEMP_DIR!\ffmpeg-tmp' -Force"
        for /d %%d in ("!TEMP_DIR!\ffmpeg-tmp\ffmpeg-*") do (
            copy /Y "%%d\bin\ffmpeg.exe" "!REPO_SRC!\vendor\ffmpeg\ffmpeg.exe" >nul 2>nul
            copy /Y "%%d\bin\ffprobe.exe" "!REPO_SRC!\vendor\ffmpeg\ffprobe.exe" >nul 2>nul
            for %%n in (LICENSE LICENSE.md COPYING.GPLv3 COPYING.GPLv2 COPYING.LGPLv2.1 COPYING.LGPLv3) do (
                if exist "%%d\%%n" copy /Y "%%d\%%n" "!REPO_SRC!\vendor\ffmpeg\%%n" >nul 2>nul
            )
            > "!REPO_SRC!\vendor\ffmpeg\SOURCE.txt" echo FFmpeg 8.1.2-essentials_build ^(GPL-3.0-or-later^)
            >> "!REPO_SRC!\vendor\ffmpeg\SOURCE.txt" echo URL: !FFMPEG_URL!
            >> "!REPO_SRC!\vendor\ffmpeg\SOURCE.txt" echo SHA-256: !FFMPEG_SHA256!
            >> "!REPO_SRC!\vendor\ffmpeg\SOURCE.txt" echo Source: https://ffmpeg.org/download.html#releases ^(ffmpeg-8.1.2.tar.xz^)
            >> "!REPO_SRC!\vendor\ffmpeg\SOURCE.txt" echo Upstream commit: 38b88335f9
        )
        del "!DL_FILE!" 2>nul
        rem Reparse check before delete as TOCTOU guard; a hit skips the delete with a warning
        call :CheckNotReparse "!TEMP_DIR!\ffmpeg-tmp"
        if "!IS_REPARSE!"=="1" (
            echo   [WARN] Skipping delete of reparse point: !TEMP_DIR!\ffmpeg-tmp
        ) else (
            rmdir /S /Q "!TEMP_DIR!\ffmpeg-tmp" 2>nul
        )
    )
    rem ffmpeg is also covered by the .gitattributes LFS rules, so check the size after
    rem download: a 133-byte pointer satisfies exist and host/bridge would treat it as usable ffmpeg.
    if exist "!REPO_SRC!\vendor\ffmpeg\ffmpeg.exe" (
        for %%s in ("!REPO_SRC!\vendor\ffmpeg\ffmpeg.exe") do set FF_SIZE2=%%~zs
    ) else (
        set FF_SIZE2=0
    )
    if !FF_SIZE2! lss 1048576 (
        echo   [WARN] ffmpeg.exe not available ^(!FF_SIZE2! bytes^) - MOV transcode disabled
        echo          Download failed or was skipped. Re-run with network access,
        echo          or place ffmpeg.exe under vendor\ffmpeg\ manually.
    ) else (
        for %%s in ("!REPO_SRC!\vendor\ffmpeg\ffmpeg.exe") do echo   [OK] ffmpeg.exe %%~zs bytes
        echo   [NOTE] FFmpeg is GPL-3.0-or-later - license texts kept in vendor\ffmpeg\ ^(redistributing it requires them + source offer^)
        set FF_OK=1
    )
    if exist "!REPO_SRC!\vendor\ffmpeg\ffprobe.exe" (
        echo   [OK] ffprobe.exe
    )
) else (
    echo   [OK] ffmpeg already present
    set FF_OK=1
)

:: node_modules (parse-doc deps: mammoth / @wwek/xlsx / unpdf)
:: The deployed bridge resolves parse-doc dependencies from <extension root>\vendor\node_modules;
:: the repo root node_modules is copied here when present. A clone that only ran npm ci lacks vendor deps.
if not exist "!REPO_SRC!\vendor\node_modules\@wwek\xlsx\xlsx.js" (
    if exist "!REPO_SRC!\node_modules\" (
        echo   Copying node_modules to vendor\node_modules...
        robocopy "!REPO_SRC!\node_modules" "!REPO_SRC!\vendor\node_modules" /E /NJH /NJS /NP /NS /NDL /R:2 /W:2 >nul
        if exist "!REPO_SRC!\tools\prune-vendor-modules.js" (
            if exist "!REPO_SRC!\vendor\node\node.exe" (
                "!REPO_SRC!\vendor\node\node.exe" "!REPO_SRC!\tools\prune-vendor-modules.js" >nul 2>nul
            ) else (
                node "!REPO_SRC!\tools\prune-vendor-modules.js" >nul 2>nul
            )
            if errorlevel 1 echo   [WARN] prune-vendor-modules failed - vendor may still contain dev packages
        )
    )
)
if exist "!REPO_SRC!\vendor\node_modules\@wwek\xlsx\xlsx.js" (
    echo   [OK] vendor\node_modules ^(parse-doc deps^)
) else (
    echo   [WARN] vendor\node_modules missing - parse-doc ^(docx/xlsx/pdf^) unavailable
)

:: ========================================
:: Step 3: Remove the old CEP deployment
:: ========================================
echo.
echo [3/5] Cleaning old deployment...
for %%d in (host client CSXS vendor) do (
    if exist "!DEST!\%%d\" (
        rmdir /S /Q "!DEST!\%%d" 2>nul
        if exist "!DEST!\%%d\" (
            echo   [WARN] Could not remove %%d - file in use? Close AE.
            goto :cleanup
        )
    )
)
if not exist "!DEST!" mkdir "!DEST!"

:: ========================================
:: Step 4: Deploy
:: ========================================
echo.
echo [4/5] Deploying...
for %%d in (host client CSXS vendor) do (
    echo   Copying %%d...
    robocopy "!REPO_SRC!\%%d" "!DEST!\%%d" /E /NJH /NJS /NP /NS /NDL /R:2 /W:2 >nul
)
if exist "!REPO_SRC!\LICENSE" copy /Y "!REPO_SRC!\LICENSE" "!DEST!\LICENSE" >nul 2>nul
set "NOTICES_SRC=!REPO_SRC!\docs\THIRD-PARTY-NOTICES.md"
if not exist "!NOTICES_SRC!" set "NOTICES_SRC=!REPO_SRC!\tools\public-overlay\docs\THIRD-PARTY-NOTICES.md"
if exist "!NOTICES_SRC!" copy /Y "!NOTICES_SRC!" "!DEST!\THIRD-PARTY-NOTICES.md" >nul 2>nul

:: -- Set PlayerDebugMode (multi-AE-version machines) --
:: CSXS.N keys are shared by all Adobe CEP hosts and the AE major version -> CSXS number
:: mapping is not stable in the registry, so all detected AE versions are covered in two ways:
::   1) Each detected AE version gets the candidate key set returned by :MapCsxs; a missing
::      key is created, so the flag is in place before the host first runs. AE 23/24 write
::      both CSXS.11 and 12 (see :MapCsxs): an extra key only enables debug for that CEP
::      host and has no side effect, while a missing key silently hides the unsigned panel
::      on first launch;
::   2) Fallback: every existing CSXS.11/12 key is written too, covering mapping drift.
:: Both sets are deduplicated via PDM_DONE_<n>; each failure prints [WARN], never silently skipped.
for %%m in (!AE_MAJOR_LIST!) do (
    if defined AE_INSTALL_%%m (
        call :MapCsxs %%m
        if defined CSXS_LIST (
            for %%c in (!CSXS_LIST!) do (
                if not defined PDM_DONE_%%c call :SetPlayerDebugMode %%c create
            )
        ) else (
            echo   [WARN] AE %%m.0 predates CSXS.8 - set PlayerDebugMode manually ^(CSXS.^<8^)
        )
    )
)
for %%v in (12 11) do (
    if not defined PDM_DONE_%%v call :SetPlayerDebugMode %%v
)

:: ========================================
:: Step 5: Verify
:: ========================================
echo.
echo ========================================
echo   [5/5] Verify
echo ========================================
set OK=1
for %%d in (host client CSXS vendor) do (
    if not exist "!DEST!\%%d\" (
        echo   [FAIL] %%d\ missing
        set OK=0
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
rem Check the size for the final verification too: a 133-byte LFS pointer satisfies exist,
rem but host.jsx would start it with ShellExecute err=193 and the bridge never starts; ffmpeg is the same case.
if exist "!DEST!\vendor\node\node.exe" (
    for %%s in ("!DEST!\vendor\node\node.exe") do set FIN_NODE=%%~zs
) else (
    set FIN_NODE=0
)
if !FIN_NODE! lss 1048576 (
    echo   [WARN] vendor\node\node.exe unusable ^(!FIN_NODE! bytes^) - possible git-lfs pointer; run git lfs pull or re-run this script
) else (
    echo   [OK]  vendor\node\node.exe
)
rem ffmpeg final check also uses size: a 133-byte LFS pointer satisfies exist but
rem bridge _findFfmpeg gives vendor priority 0, so transcoding keeps reporting no encoder.
if exist "!DEST!\vendor\ffmpeg\ffmpeg.exe" (
    for %%s in ("!DEST!\vendor\ffmpeg\ffmpeg.exe") do set FIN_FF=%%~zs
) else (
    set FIN_FF=0
)
if !FIN_FF! lss 1048576 (
    set FF_OK=0
    echo   [WARN] vendor\ffmpeg\ffmpeg.exe unusable ^(!FIN_FF! bytes^) - failed download or git-lfs pointer
    echo          Re-run this script with network access, or place ffmpeg.exe under vendor\ffmpeg\.
) else (
    set FF_OK=1
    echo   [OK]  vendor\ffmpeg\ffmpeg.exe
)
if not exist "!DEST!\vendor\node_modules\@wwek\xlsx\xlsx.js" (
    echo   [WARN] vendor\node_modules missing - parse-doc ^(docx/xlsx/pdf^) unavailable
) else (
    echo   [OK]  vendor\node_modules ^(parse-doc deps^)
)

:: -- Optional: deploy native .aex files if local build output exists --
:: Every detected AE version is attempted.
:: A GitHub source download has no .aex (it needs VS + the AE SDK), so this step is skipped;
:: a developer build in deploy\Plug-ins\*.aex is deployed into each AE Plug-ins folder.
set HAVE_AEX=0
if exist "!REPO_SRC!\deploy\Plug-ins\AS_Hotbox.aex" set HAVE_AEX=1
if exist "!REPO_SRC!\deploy\Plug-ins\AS_Effect_Host.aex" set HAVE_AEX=1
if !HAVE_AEX!==1 (
    echo.
    echo ========================================
    echo   Native plugins ^(optional^)
    echo ========================================
    call :DeployAex AS_Hotbox.aex
    call :DeployAex AS_Effect_Host.aex
)

:: Summary: versions that have an AE key but an unreadable InstallPath are skipped as a whole;
:: the install still completes, and the count is reported before the conclusion.
if !AE_KEY_COUNT! GTR !AE_COUNT! (
    set /a AE_SKIP_COUNT=!AE_KEY_COUNT! - !AE_COUNT!
    echo   [WARN] !AE_SKIP_COUNT! detected AE version^(s^) skipped: InstallPath unreadable
    echo          No Plug-ins ^(.aex^) deploy and no PlayerDebugMode for them - handle manually
)
:: AE versions below the minimum are untouched by the whole install (no panel, no PlayerDebugMode, no .aex); the summary reports them.
if !AE_OLD_COUNT! GTR 0 (
    echo   [WARN] !AE_OLD_COUNT! AE version^(s^) below minimum ^(AE 2023 / 23.0^) skipped: !AE_OLD_LIST!
    echo          No panel deploy, no PlayerDebugMode, no Plug-ins ^(.aex^) for them
)

echo.
if !FF_OK!==0 (
    echo   [WARN] ffmpeg unavailable - MOV transcode disabled ^(install is otherwise usable^)
    echo          Re-run this script with network access, or place ffmpeg.exe under vendor\ffmpeg\.
)
if !OK!==1 (
    echo   Install complete!
    echo   Restart AE ^> Window ^> Extensions ^> AS_ExtP
) else (
    echo   [!] Some files missing. Check network / permissions.
)

:cleanup
rem Reparse check before delete as TOCTOU guard; a hit skips the delete with a warning
call :CheckNotReparse "!TEMP_DIR!"
if "!IS_REPARSE!"=="1" (
    echo [WARN] Skipping delete of reparse point: !TEMP_DIR!
) else (
    rmdir /S /Q "!TEMP_DIR!" 2>nul
)
echo.
pause
exit /b

:: ========================================
:: :Download subroutine - three fallbacks + resume + pinned SHA256 verification
:: Params: %1=URL %2=output file %3=expected SHA256 (optional; empty falls back to the >1024 bytes check)
:: Returns: DL_OK=1 on success
:: With a pinned hash SHA256 is the only completion test: mismatch deletes the file and tries the next method/source
:: ========================================
:Download
set DL_OK=0
set "DL_URL=%~1"
set "DL_FILE=%~2"
set "DL_EXPECTED_SHA256=%~3"

:: An existing file passes :CheckFile first (with a pinned hash the hash decides; mismatches are deleted there)
call :CheckFile
if !DL_OK!==1 exit /b

:: Resume: a partial file is continued with curl -C
:: :CheckFile above deletes every hash-mismatched file, so this branch is a fallback only
if exist "!DL_FILE!" (
    for %%f in ("!DL_FILE!") do set DL_PARTIAL=%%~zf
    if !DL_PARTIAL! gtr 0 (
        echo     [0/3] Resuming partial download ^(!DL_PARTIAL! bytes^)...
        curl.exe -# -L -C - -o "!DL_FILE!" "!DL_URL!" 2>&1
        call :CheckFile
    )
    if !DL_OK!==0 del "!DL_FILE!" 2>nul
)

rem curl first: resumable and fast for large files; PowerShell is the fallback when curl is missing
where curl.exe >nul 2>nul
if !errorlevel!==0 (
    if !DL_OK!==0 (
        echo     [1/3] curl...
        curl.exe -# -L -C - -o "!DL_FILE!" "!DL_URL!" 2>&1
        call :CheckFile
    )
)

if !DL_OK!==0 (
    echo     [2/3] PowerShell...
    powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -Uri '!DL_URL!' -OutFile '!DL_FILE!' -UseBasicParsing } catch { exit 1 }" 2>nul
    call :CheckFile
)

if !DL_OK!==0 (
    echo     [3/3] certutil...
    certutil -urlcache -split -f "!DL_URL!" "!DL_FILE!" >nul 2>nul
    call :CheckFile
)
exit /b

:: ========================================
:: Completion test - with a pinned hash SHA256 is the only test and a mismatch deletes the file;
::     without an expected value (repo zip only) it falls back to >1024 bytes
:: ========================================
:CheckFile
if not exist "!DL_FILE!" exit /b
if "!DL_EXPECTED_SHA256!"=="" (
    for %%f in ("!DL_FILE!") do if %%~zf gtr 1024 set DL_OK=1
    exit /b
)
for %%f in ("!DL_FILE!") do if %%~zf leq 1024 exit /b
call :VerifySha256
if "!DL_HASH_OK!"=="1" (
    set DL_OK=1
) else (
    echo     [FAIL] SHA256 mismatch ^(got !DL_ACTUAL!^) - file deleted, trying next method/source
    del "!DL_FILE!" 2>nul
)
exit /b

:: ========================================
:: certutil computes the SHA256 of DL_FILE and compares it with DL_EXPECTED_SHA256
:: Result: DL_HASH_OK=1 match / 0 mismatch; DL_ACTUAL holds the actual hash
:: ========================================
:VerifySha256
set DL_HASH_OK=0
set "DL_ACTUAL="
if not exist "!DL_FILE!" exit /b
:: certutil prints the hash on its second output line; spaces are stripped for older grouped formats
for /f "skip=1 delims=" %%h in ('certutil -hashfile "!DL_FILE!" SHA256 2^>nul') do if not defined DL_ACTUAL set "DL_ACTUAL=%%h"
if not defined DL_ACTUAL exit /b
set "DL_ACTUAL=!DL_ACTUAL: =!"
if /I "!DL_ACTUAL!"=="!DL_EXPECTED_SHA256!" set DL_HASH_OK=1
exit /b

:: ========================================
:: Test whether %1 is a reparse point (junction/symlink)
:: Result: IS_REPARSE=1 yes / 0 no (a missing path also returns 0; the caller decides)
:: The path reaches PowerShell through an environment variable to avoid quote injection
:: ========================================
:CheckNotReparse
set IS_REPARSE=0
if not exist "%~1" exit /b
set "CHK_PATH=%~1"
for /f "delims=" %%r in ('powershell -NoProfile -Command "if ((Get-Item -LiteralPath $env:CHK_PATH -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { 1 }" 2^>nul') do set IS_REPARSE=%%r
set "CHK_PATH="
exit /b

:: ========================================
:: AE major version -> candidate CSXS key set (Cookbook mapping, both keys written as a safeguard)
:: Source: the Adobe CEP Cookbook (CEP 12 host table) lists "AE 18.4=CEP 11" and
::       "AE 25.0=CEP 12": AE 23/24 map to CSXS.11, AE 25+ to CSXS.12;
::       the repo README lists CSXS.11 for AE 2023/2024 and CSXS.12 for AE 2025+.
:: Both sources agree on AE 2024; AE 23/24 still write {11,12}:
:: an extra key has no side effect, a missing key silently hides the panel on first launch (when CSXS.11 does not exist yet).
:: The 15-22 entries follow the same Cookbook host table.
:: Returns: CSXS_LIST=<space-separated candidate key numbers>; empty when nothing applies (AE <=14, i.e. CSXS <=7)
:: ========================================
:MapCsxs
set "CSXS_LIST="
if %~1 GEQ 25 set "CSXS_LIST=12"
if %~1 EQU 24 set "CSXS_LIST=11 12"
if %~1 EQU 23 set "CSXS_LIST=11 12"
if %~1 EQU 22 set "CSXS_LIST=11"
if %~1 EQU 18 set "CSXS_LIST=11"
if %~1 EQU 17 set "CSXS_LIST=10"
if %~1 EQU 16 set "CSXS_LIST=9"
if %~1 EQU 15 set "CSXS_LIST=8"
exit /b

:: ========================================
:: Write HKCU\SOFTWARE\Adobe\CSXS.<n>\PlayerDebugMode=1
:: Params: %1=CSXS key number; %2=create also creates a missing key (only for detected AE versions)
:: Result: PDM_DONE_<n>=1 marks success, used to deduplicate the fallback scan; a failure prints [WARN]
:: ========================================
:SetPlayerDebugMode
set "PDM_KEY=HKCU\SOFTWARE\Adobe\CSXS.%~1"
if /I not "%~2"=="create" (
    reg query "!PDM_KEY!" >nul 2>nul
    if !errorlevel! NEQ 0 exit /b
)
reg add "!PDM_KEY!" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>nul
if !errorlevel!==0 (
    set "PDM_DONE_%~1=1"
    echo   [OK] PlayerDebugMode set ^(CSXS.%~1^)
) else (
    echo   [WARN] Could not set PlayerDebugMode ^(CSXS.%~1 - access denied?^)
)
exit /b

:: ========================================
:: Deploy the .aex named by %1 into the Support Files\Plug-ins of every detected AE
:: Missing source -> [SKIP]; missing dir / copy failure -> [WARN] (never silently skipped)
:: Result: AEX_FAIL = number of failed targets (a summary [WARN] line when >0)
:: ========================================
:DeployAex
set "AEX_NAME=%~1"
if not exist "!REPO_SRC!\deploy\Plug-ins\!AEX_NAME!" (
    echo   [SKIP] !AEX_NAME! not built locally - nothing to deploy
    exit /b
)
:: The Plug-ins dir is resolved by existence. Two layouts are covered: InstallPath pointing at
:: the application root, and InstallPath pointing at Support Files. The registry value
:: normally already ends with "...\Adobe After Effects 2023\Support Files\" (the folder
:: holding AfterFX.exe), so a fixed "\Support Files\Plug-ins" suffix does not apply to it.
:: Both candidates are probed for each detected AE version.
set AEX_FAIL=0
for %%m in (!AE_MAJOR_LIST!) do (
    if defined AE_INSTALL_%%m (
        rem Candidate 1: InstallPath is the app root; candidate 2: InstallPath is already Support Files
        set "AE_PLUGIN_DIR="
        if exist "!AE_INSTALL_%%m!\Plug-ins\" set "AE_PLUGIN_DIR=!AE_INSTALL_%%m!\Plug-ins"
        if not defined AE_PLUGIN_DIR if exist "!AE_INSTALL_%%m!\Support Files\Plug-ins\" set "AE_PLUGIN_DIR=!AE_INSTALL_%%m!\Support Files\Plug-ins"
        if not defined AE_PLUGIN_DIR (
            echo   [WARN] !AEX_NAME!: Plug-ins dir not found for AE %%m.0 ^(looked under !AE_INSTALL_%%m!^)
            set /a AEX_FAIL+=1
        ) else if exist "!AE_PLUGIN_DIR!\!AEX_NAME!" (
            echo   [SKIP] !AEX_NAME! already exists for AE %%m.0 - kept as-is, not overwritten
            echo          If you just installed a NEWER build, delete or replace this file
            echo          manually in "!AE_PLUGIN_DIR!" then re-run / reinstall to take effect.
        ) else (
            copy /Y "!REPO_SRC!\deploy\Plug-ins\!AEX_NAME!" "!AE_PLUGIN_DIR!\" >nul 2>nul
            if exist "!AE_PLUGIN_DIR!\!AEX_NAME!" (
                echo   [OK]  !AEX_NAME! deployed to AE %%m.0 Plug-ins
            ) else (
                echo   [WARN] Could not copy !AEX_NAME! to AE %%m.0 ^(AE running? Close AE.^)
                set /a AEX_FAIL+=1
            )
        )
    )
)
if !AEX_FAIL! GTR 0 echo   [WARN] !AEX_NAME!: !AEX_FAIL! target^(s^) failed
exit /b
