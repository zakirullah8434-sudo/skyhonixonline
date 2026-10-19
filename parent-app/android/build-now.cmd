@echo off
setlocal
set "JAVA_HOME=F:\C_Moved\UserProfile\Desktop\Projects Apks\1 SkyHonix sms apk\jdk-17.0.13+11"
set "ANDROID_HOME=C:\Users\PC\AppData\Local\Android\Sdk"
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
cd /d "%~dp0"
call gradlew.bat assembleDebug --console=plain > build-now.log 2>&1
echo EXIT=%ERRORLEVEL% >> build-now.log
