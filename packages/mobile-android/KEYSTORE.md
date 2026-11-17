# 小蜻蜓 Android 签名 key 管理

## 约定

- keystore **不入库**（`.gitignore` 已排除 `*.keystore`、`*.jks`、`local.properties`）。
- release 签名经以下任一途径注入（`app/build.gradle.kts` 的 signingConfigs.release）：
  - 环境变量：`BLM_KEYSTORE_PATH`、`BLM_KEYSTORE_PASSWORD`、`BLM_KEY_ALIAS`（可选，默认 xiaoqingting）
  - `local.properties`：`blm.keystore.path` / `blm.keystore.password` / `blm.keystore.alias`
- 两者都没有时 release 退化为 debug 签名——**仅供本地测试**，发布的 APK 必须用正式 key。

## 生成（一次性）

```bash
keytool -genkeypair -v \
  -keystore xiaoqingting-release.keystore \
  -alias xiaoqingting -keyalg RSA -keysize 2048 \
  -validity 10000
```

## 备份

keystore 丢失 = 无法覆盖升级（用户只能卸载重装 + 重新登录）。
请至少备份一份到密码管理器/离线介质，并妥善保管密码。

## 验证签名

```bash
~/.android-sdk/build-tools/35.0.0/apksigner verify --print-certs app-release.apk
```
