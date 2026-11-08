@echo off
chcp 65001 >nul
title Xiaoqingting 一键启动
echo ========================================
echo  Xiaoqingting (小蜻蜓) - 全本地 AI 助手
echo ========================================
echo.

REM 检查 Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 未检测到 Node.js，请先安装 Node.js 20+
    pause
    exit /b 1
)
echo ✅ Node.js: %node: =%

REM 检查 .env
if not exist packages\server\.env (
    echo ⚠️  未找到 packages\server\.env
    if exist packages\server\.env.example (
        copy packages\server\.env.example packages\server\.env >nul
        echo 📋 已从 .env.example 复制模板，请编辑填入 Key
    ) else (
        echo ❌ 缺少 .env.example
        pause
        exit /b 1
    )
) else (
    echo ✅ 环境配置已存在
)

echo.
echo 启动服务端 (后台最小化)...
start "Xiaoqingting-Server" /min /b cmd /c "npm run dev:server"
timeout /t 3 >nul

echo 启动桌面端 (后台最小化)...
start "Xiaoqingting-Desktop" /min /b cmd /c "npm run dev:desktop"
timeout /t 2 >nul

echo.
echo ✅ 启动完成！
echo.
echo 服务端: http://localhost:8788
echo 桌面端: 已在托盘/任务栏
echo.
echo 按任意键关闭此窗口（后台进程继续运行）
pause >nul