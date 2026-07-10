@echo off
cd /d "%~dp0.."
echo.
echo Configurar e-mail do Dragonfall (Esqueci a senha)
echo.
call npm run df:setup:mail
pause
