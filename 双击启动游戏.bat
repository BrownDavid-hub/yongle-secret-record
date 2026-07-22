@echo off
chcp 65001 >nul
title 永乐秘闻录 - 本地游戏服务
cd /d "%~dp0"
echo 正在启动游戏，请不要关闭此窗口。
start "" "http://localhost:3000"
node "%~dp0server.js"
pause
