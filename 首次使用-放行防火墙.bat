@echo off
chcp 65001 >nul
:: 自动请求管理员权限
net session >nul 2>&1
if errorlevel 1 (
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall delete rule name="YongleGame3000" >nul 2>&1
netsh advfirewall firewall add rule name="YongleGame3000" dir=in action=allow protocol=TCP localport=3000 profile=private
echo.
echo 防火墙已放行 3000 端口（仅专用网络），以后手机就能连了。
echo 此操作只需做一次。
pause
