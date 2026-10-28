@echo off
echo === Xlam Connect: сборка для Windows ===
where node >nul 2>nul || (echo Установите Node.js 20+ с https://nodejs.org & pause & exit /b 1)
call npm install || (pause & exit /b 1)
call npm run dist || (pause & exit /b 1)
echo.
echo Готово! Установщик и portable-версия лежат в папке dist\
pause
