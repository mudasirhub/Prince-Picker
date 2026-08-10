@echo off
cd /d "%~dp0"
echo ========================================================
echo Pushing Prince Picker with Supabase Integration to GitHub
echo Current Folder: %CD%
echo ========================================================
echo.

echo Syncing PWA app icons...
node copy_icons.js

git add .
git commit -m "fix: update Cloudflare R2 public URL & single source of truth Drop stock sync"
git push

echo.
echo ========================================================
echo Successfully pushed to GitHub!
echo ========================================================
pause
