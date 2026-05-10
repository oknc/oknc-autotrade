#!/bin/bash
# ============================================================
# OKNC 自动交易系统 - APK 构建脚本
# 在装有 Android Studio 的电脑上运行
# 用法: bash build-apk.sh
# ============================================================
set -e

APP_NAME="OKNC交易"
APP_ID="com.oknc.trade"
PWA_URL="https://trade.oknc.club"
OUTPUT_DIR="./build-apk-output"

echo "========================================"
echo "  OKNC APK Builder v1.0"
echo "  目标: $PWA_URL"
echo "========================================"

# ---------- 检查环境 ----------
echo ""
echo "[1/5] 检查 Android SDK 环境..."

ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
if [ ! -d "$ANDROID_HOME" ]; then
  echo "❌ 未找到 Android SDK，请设置 ANDROID_HOME"
  echo "   例如: export ANDROID_HOME=~/Android/Sdk"
  exit 1
fi
echo "  ✅ Android SDK: $ANDROID_HOME"

BUILD_TOOLS=$(ls -1 "$ANDROID_HOME/build-tools/" 2>/dev/null | sort -V | tail -1)
[ -z "$BUILD_TOOLS" ] && { echo "❌ 未找到 build-tools"; exit 1; }
echo "  ✅ Build-tools: $BUILD_TOOLS"

PLATFORM=$(ls -1 "$ANDROID_HOME/platforms/" 2>/dev/null | sort -V | tail -1)
[ -z "$PLATFORM" ] && { echo "❌ 未找到 platform"; exit 1; }
API_LEVEL=$(echo "$PLATFORM" | sed 's/android-//')
echo "  ✅ Platform: $PLATFORM (API $API_LEVEL)"

JAVA_HOME="${JAVA_HOME:-$(dirname $(dirname $(readlink -f $(which javac 2>/dev/null))) 2>/dev/null)}"
[ ! -f "$JAVA_HOME/bin/javac" ] && { echo "❌ 未找到 JDK"; exit 1; }
echo "  ✅ JDK: $($JAVA_HOME/bin/java -version 2>&1 | head -1)"

# ---------- 创建项目 ----------
echo ""
echo "[2/5] 创建 Android 项目..."
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/app/src/main/java/com/oknc/trade"
mkdir -p "$OUTPUT_DIR/app/src/main/res/values"
mkdir -p "$OUTPUT_DIR/app/src/main/res/drawable"

# ---------- 图标 ----------
echo "[3/5] 生成图标..."
python3 -c "
from PIL import Image, ImageDraw
s=192; img=Image.new('RGBA',(s,s),(10,14,23,255)); d=ImageDraw.Draw(img)
for y in range(s):
    r=int(10+(88-10)*y/s); g=int(14+(166-14)*y/s); b=int(23+(255-23)*y/s)
    d.line([(0,y),(s,y)],fill=(r,g,b,255))
m=int(s*0.08); d.ellipse([m,m,s-m,s-m],outline='#58a6ff',width=6)
d.text((s//2-20,s//2-25),'O',fill='white')
img.save('$OUTPUT_DIR/app/src/main/res/drawable/icon.png')
" 2>/dev/null || echo "  ⚠️ 图标生成跳过（需安装 Pillow: pip install Pillow）"

# ---------- 源码 ----------
echo "[4/5] 写入源码..."

cat > "$OUTPUT_DIR/app/src/main/AndroidManifest.xml" << 'MANIFEST'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.oknc.trade"
    android:versionCode="1"
    android:versionName="1.0.0">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:allowBackup="true"
        android:icon="@drawable/icon"
        android:label="OKNC交易"
        android:theme="@android:style/Theme.Black.NoTitleBar.Fullscreen">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:screenOrientation="portrait">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
MANIFEST

cat > "$OUTPUT_DIR/app/src/main/java/com/oknc/trade/MainActivity.java" << 'JAVAEOF'
package com.oknc.trade;
import android.app.Activity;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.FrameLayout;
import android.view.ViewGroup;
import android.view.View;
import android.graphics.Color;
public class MainActivity extends Activity {
    private WebView webView;
    private ProgressBar progressBar;
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout layout = new FrameLayout(this);
        progressBar = new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);
        progressBar.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,4));
        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.setWebViewClient(new WebViewClient(){
            public void onPageStarted(WebView v,String u,Bitmap f){ progressBar.setVisibility(View.VISIBLE); }
            public void onPageFinished(WebView v,String u){ progressBar.setVisibility(View.GONE); }
            public boolean shouldOverrideUrlLoading(WebView v,String u){ return false; }
        });
        webView.loadUrl("https://trade.oknc.club");
        layout.addView(webView,new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT));
        layout.addView(progressBar);
        setContentView(layout);
    }
    @Override
    protected void onDestroy(){ if(webView!=null)webView.destroy(); super.onDestroy(); }
}
JAVAEOF

cat > "$OUTPUT_DIR/settings.gradle" << 'EOF'
rootProject.name = 'OKNC'
include ':app'
EOF

# 智能选择 AGP 版本
if [ "$API_LEVEL" -ge 34 ]; then
  AGP="8.2.0"
elif [ "$API_LEVEL" -ge 33 ]; then
  AGP="8.0.2"
elif [ "$API_LEVEL" -ge 31 ]; then
  AGP="7.4.2"
else
  AGP="4.2.2"
fi

cat > "$OUTPUT_DIR/build.gradle" << GRADLEEOF1
buildscript {
    repositories { google(); mavenCentral() }
    dependencies { classpath 'com.android.tools.build:gradle:$AGP' }
}
allprojects {
    repositories { google(); mavenCentral() }
}
GRADLEEOF1

cat > "$OUTPUT_DIR/app/build.gradle" << GRADLEEOF2
apply plugin: 'com.android.application'
android {
    compileSdk $API_LEVEL
    defaultConfig {
        applicationId 'com.oknc.trade'
        minSdk 23
        targetSdk $API_LEVEL
        versionCode 1
        versionName '1.0.0'
    }
    buildTypes { release { minifyEnabled false } }
}
GRADLEEOF2

echo "sdk.dir=$ANDROID_HOME" > "$OUTPUT_DIR/local.properties"

# ---------- 构建 ----------
echo ""
echo "[5/5] 构建 APK..."
cd "$OUTPUT_DIR"

if command -v gradle &>/dev/null; then
  gradle assembleDebug --no-daemon 2>&1 | tail -15
else
  echo "❌ 未找到 gradle 命令"
  echo "   请安装: sudo apt install gradle 或使用 Android Studio 内置 gradle"
  exit 1
fi

APK_FILE=$(find . -name "*.apk" -path "*/outputs/*" | head -1)
if [ -n "$APK_FILE" ]; then
  cp "$APK_FILE" "../OKNC-Trade-v1.0.0.apk"
  echo ""
  echo "========================================"
  echo "  ✅ APK 构建成功!"
  echo "  文件: $(pwd)/../OKNC-Trade-v1.0.0.apk"
  echo "  大小: $(du -h ../OKNC-Trade-v1.0.0.apk | cut -f1)"
  echo "========================================"
  echo ""
  echo "上传到服务器:"
  echo "  scp ../OKNC-Trade-v1.0.0.apk root@43.133.241.141:/root/autotrade/public/"
  echo ""
  echo "然后访问: https://trade.oknc.club/OKNC-Trade-v1.0.0.apk"
else
  echo "❌ APK 未找到，检查上方错误"
  exit 1
fi
