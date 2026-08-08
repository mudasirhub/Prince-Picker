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
git commit -m "fix: resolve Temporal Dead Zone (TDZ) initialization crashes for DROP, DEMO_PRODUCTS, and adhocState in index.html"
git push

echo.
echo ========================================================
echo Successfully pushed to GitHub!
echo ========================================================
pause
