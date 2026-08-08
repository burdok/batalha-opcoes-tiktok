@echo off
setlocal
cd /d "%~dp0"
title Batalha de Opcoes - Conector TikTok
where node >nul 2>nul
if errorlevel 1 (
  echo ERRO: Node.js nao encontrado.
  echo Instale Node.js 20 ou superior.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Instalando dependencias...
  call npm install
  if errorlevel 1 (
    echo ERRO ao instalar dependencias.
    pause
    exit /b 1
  )
)
node connector.js
pause
