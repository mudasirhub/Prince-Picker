@echo off
cd /d "%~dp0"
echo ========================================================
echo Pushing Prince Picker with Supabase Integration to GitHub
echo Current Folder: %CD%
echo ========================================================
echo.

git add .
git commit -m "feat: Add Supabase integration, offline IndexedDB sync, supplier QR parser, and PWA updates"
git push

echo.
echo ========================================================
echo Successfully pushed to GitHub!
echo ========================================================
pause
