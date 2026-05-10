# ============================================================
# OKNC 自动交易系统 - APK 构建脚本 (Windows PowerShell 版)
# 保存到电脑上，右键 → "使用 PowerShell 运行"
# ============================================================

$APP_NAME = "OKNC交易"
$APP_ID = "com.oknc.trade"
$PWA_URL = "https://trade.oknc.club"
$OUTPUT_DIR = ".\build-apk-output"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  OKNC APK Builder v1.0 (Windows)" -ForegroundColor Cyan
Write-Host "  目标: $PWA_URL" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Write-Host "`n[1/4] 检查环境..." -ForegroundColor Yellow
$ANDROID_HOME = $env:ANDROID_HOME
if (-not $ANDROID_HOME) {
    $candidates = @("$env:LOCALAPPDATA\Android\Sdk","$env:USERPROFILE\AppData\Local\Android\Sdk","C:\Android\Sdk")
    foreach ($p in $candidates) { if (Test-Path $p) { $ANDROID_HOME = $p; break } }
}
if (-not $ANDROID_HOME -or -not (Test-Path $ANDROID_HOME)) {
    Write-Host "❌ 未找到 Android SDK" -ForegroundColor Red; pause; exit 1
}
Write-Host "  Android SDK: $ANDROID_HOME" -ForegroundColor Green

$BUILD_TOOLS = Get-ChildItem "$ANDROID_HOME\build-tools" -Directory | Sort-Object Name -Descending | Select-Object -First 1
$PLATFORM = Get-ChildItem "$ANDROID_HOME\platforms" -Directory | Sort-Object Name -Descending | Select-Object -First 1
$API_LEVEL = $PLATFORM.Name -replace 'android-', ''
Write-Host "  Build-tools: $($BUILD_TOOLS.Name) | Platform: API $API_LEVEL" -ForegroundColor Green

Write-Host "`n[2/4] 创建项目..." -ForegroundColor Yellow
if (Test-Path $OUTPUT_DIR) { Remove-Item -Recurse -Force $OUTPUT_DIR }
@("$OUTPUT_DIR\app\src\main\java\com\oknc\trade","$OUTPUT_DIR\app\src\main\res\values","$OUTPUT_DIR\app\src\main\res\drawable") | % { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

@"
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="$APP_ID" android:versionCode="1" android:versionName="1.0.0">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:allowBackup="true" android:icon="@drawable/icon"
        android:label="$APP_NAME" android:theme="@android:style/Theme.Black.NoTitleBar.Fullscreen">
        <activity android:name=".MainActivity" android:exported="true" android:screenOrientation="portrait">
            <intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
        </activity>
    </application>
</manifest>
"@ | Out-File "$OUTPUT_DIR\app\src\main\AndroidManifest.xml" -Encoding utf8

@"
package com.oknc.trade;
import android.app.Activity; import android.os.Bundle; import android.webkit.WebView;
import android.webkit.WebViewClient; import android.widget.ProgressBar; import android.widget.FrameLayout;
import android.view.ViewGroup; import android.view.View; import android.graphics.Color; import android.graphics.Bitmap;
public class MainActivity extends Activity {
    WebView w; ProgressBar p;
    @Override protected void onCreate(Bundle s) {
        super.onCreate(s); FrameLayout l = new FrameLayout(this);
        p = new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);
        p.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,4));
        w = new WebView(this); w.getSettings().setJavaScriptEnabled(true); w.getSettings().setDomStorageEnabled(true);
        w.setWebViewClient(new WebViewClient(){
            public void onPageStarted(WebView v,String u,Bitmap f){ p.setVisibility(View.VISIBLE); }
            public void onPageFinished(WebView v,String u){ p.setVisibility(View.GONE); }
            public boolean shouldOverrideUrlLoading(WebView v,String u){ return false; }
        });
        w.loadUrl("$PWA_URL");
        l.addView(w,new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT));
        l.addView(p); setContentView(l);
    }
    @Override protected void onDestroy(){ if(w!=null)w.destroy(); super.onDestroy(); }
}
"@ | Out-File "$OUTPUT_DIR\app\src\main\java\com\oknc\trade\MainActivity.java" -Encoding utf8

"rootProject.name = 'OKNC'; include ':app'" | Out-File "$OUTPUT_DIR\settings.gradle" -Encoding utf8
$AGP = if($API_LEVEL -ge 34){"8.2.0"}elseif($API_LEVEL -ge 33){"8.0.2"}elseif($API_LEVEL -ge 31){"7.4.2"}else{"4.2.2"}
@"
buildscript { repositories { google(); mavenCentral() }
  dependencies { classpath 'com.android.tools.build:gradle:$AGP' } }
allprojects { repositories { google(); mavenCentral() } }
"@ | Out-File "$OUTPUT_DIR\build.gradle" -Encoding utf8
@"
apply plugin: 'com.android.application'
android { compileSdk $API_LEVEL
  defaultConfig { applicationId '$APP_ID' minSdk 23 targetSdk $API_LEVEL versionCode 1 versionName '1.0.0' }
  buildTypes { release { minifyEnabled false } } }
"@ | Out-File "$OUTPUT_DIR\app\build.gradle" -Encoding utf8
" sdk.dir=$ANDROID_HOME".Replace('\','/') | Out-File "$OUTPUT_DIR\local.properties" -Encoding utf8
[System.IO.File]::WriteAllBytes("$OUTPUT_DIR\app\src\main\res\drawable\icon.png", [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="))
Write-Host "  项目创建完成" -ForegroundColor Green

Write-Host "`n[3/4] 构建 APK..." -ForegroundColor Yellow
Set-Location $OUTPUT_DIR
if (Get-Command "gradle" -ErrorAction SilentlyContinue) { gradle assembleDebug --no-daemon 2>&1 }
else { Write-Host "❌ 未找到 gradle，请安装 Android Studio" -ForegroundColor Red; pause; exit 1 }

$APK = Get-ChildItem -Recurse -Filter "*.apk" | Where-Object FullName -match outputs | Select-Object -First 1
if ($APK) {
    Copy-Item $APK.FullName ".\..\OKNC-Trade-v1.0.0.apk"
    Write-Host "`n✅ APK 构建成功!" -ForegroundColor Green
    Write-Host "文件: $(Get-Item .\..\OKNC-Trade-v1.0.0.apk).FullName" -ForegroundColor White
    Write-Host "`n上传到服务器:" -ForegroundColor Yellow
    Write-Host "  scp .\OKNC-Trade-v1.0.0.apk root@43.133.241.141:/root/autotrade/public/" -ForegroundColor White
    Write-Host "  密码: Mxl`$29883880" -ForegroundColor Gray
} else { Write-Host "❌ 失败" -ForegroundColor Red }
pause
