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
git commit -m "feat: 10/10 Enterprise R2 image pipeline, Supabase sync, manual input, and PWA updates"
git push

echo.
echo ========================================================
echo Successfully pushed to GitHub!
echo ========================================================
pause
