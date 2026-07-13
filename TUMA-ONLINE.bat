@echo off
title Forwarder - Laptop to Internet
echo.
echo  ╔══════════════════════════════════════╗
echo  ║   FORWARDER - Inatuma data online    ║
echo  ╚══════════════════════════════════════╝
echo.
cd /d "%~dp0"
node forwarder.js
pause
