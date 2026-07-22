@echo off
cd /d "%~dp0"
if not exist "%~dp0config.local.js" set /p DEEPSEEK_API_KEY=请输入 DeepSeek API Key（不会保存）：
start "" "http://localhost:3000"
node "%~dp0server.js"
