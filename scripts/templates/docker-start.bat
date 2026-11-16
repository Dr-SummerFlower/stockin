@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM 自动生成来源白名单并启动，避免「请求来源校验失败」(403)。
REM 白名单通过环境变量传给 compose（优先级高于 .env），不改写 .env。
set "PORT=8080"
for /f "usebackq tokens=1,* delims==" %%a in (".env") do if "%%a"=="HOST_PORT" set "PORT=%%b"

set "ORIGINS=http://127.0.0.1:%PORT%,http://localhost:%PORT%"
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do (
  set "IP=%%i"
  set "IP=!IP: =!"
  if not "!IP!"=="" if not "!IP:~0,3!"=="127" set "ORIGINS=!ORIGINS!,http://!IP!:%PORT%"
)
for /f "usebackq tokens=1,* delims==" %%a in (".env") do if "%%a"=="EXTRA_ORIGINS" set "ORIGINS=!ORIGINS!,%%b"

echo 来源白名单：!ORIGINS!
set "PUBLIC_ORIGINS=!ORIGINS!"
docker compose up -d
