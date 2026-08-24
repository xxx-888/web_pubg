@echo off
chcp 65001 >nul
cd /d "%~dp0"
title FIREZONE 烽区
echo.
echo  ========================================
echo    FIREZONE 烽区  网页吃鸡
echo  ========================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo [1/2] 正在安装依赖，首次需要一点时间...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
  )
)
echo [2/2] 启动服务器...
echo.
node server/index.js
pause
