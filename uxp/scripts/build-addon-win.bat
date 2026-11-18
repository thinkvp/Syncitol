@echo off
rem Build the Windows native addon: native\build\win\syncitol.uxpaddon
rem
rem   scripts\build-addon-win.bat [FfmpegRoot]
rem
rem FfmpegRoot is the install prefix of the static, audio-only FFmpeg build
rem (scripts\build-ffmpeg-win.sh); it defaults to F:\ffbuild\out-static.
rem Needs Visual Studio 2022 (Build Tools is enough) with the C++ workload.
rem The built addon is copied into win\x64\ only when "install" is passed
rem as the second argument, so a test build never replaces the committed one
rem by accident.

setlocal
set "HERE=%~dp0"
set "FFROOT=%~1"
if "%FFROOT%"=="" set "FFROOT=F:\ffbuild\out-static"

set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" ( echo vcvars64.bat not found - install Visual Studio 2022 C++ build tools & exit /b 1 )
call "%VCVARS%" >nul
if errorlevel 1 ( echo VCVARS_FAILED & exit /b 1 )

msbuild "%HERE%..\native\win\syncitol.vcxproj" /nologo /v:minimal /p:Configuration=Release /p:Platform=x64 "/p:FfmpegRoot=%FFROOT%"
if errorlevel 1 ( echo BUILD_FAILED & exit /b 1 )

if /i "%~2"=="install" (
    copy /y "%HERE%..\native\build\win\syncitol.uxpaddon" "%HERE%..\win\x64\syncitol.uxpaddon" >nul
    echo Installed into win\x64\syncitol.uxpaddon
)
echo BUILD_OK native\build\win\syncitol.uxpaddon
