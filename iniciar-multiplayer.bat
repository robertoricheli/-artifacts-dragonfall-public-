@echo off
title Dragonfall — servidor multiplayer
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  ERRO: Node.js nao encontrado.
  echo  Instale em https://nodejs.org e tente de novo.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo.
  echo  Instalando dependencias (npm install)…
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo  Falha ao instalar dependencias.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo  Dragonfall MULTIPLAYER — porta 8787
echo  URL: http://127.0.0.1:8787/
echo.
echo  Para JOGAR o jogo localmente, use na RAIZ do projeto:
echo    jogar-local.bat   ^(porta 5173^)
echo.
echo  Pressione Ctrl+C para parar.
echo.

node index.mjs
if errorlevel 1 (
  echo.
  echo  Servidor encerrou com erro. Veja a mensagem acima.
  echo.
)
pause
