plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.xiaoqingting.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.xiaoqingting.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-android"
    }

    // M2 起只打 arm64（真机覆盖面足够，省体积）。
    splits {
        abi {
            isEnable = false
        }
    }

    signingConfigs {
        // release key 经 local.properties / 环境变量注入，keystore 不入库。
        create("release") {
            val kp = rootProject.file("local.properties")
            val props = java.util.Properties().apply {
                if (kp.exists()) kp.inputStream().use { load(it) }
            }
            val storePath = System.getenv("BLM_KEYSTORE_PATH")
                ?: props.getProperty("blm.keystore.path")
            val storePass = System.getenv("BLM_KEYSTORE_PASSWORD")
                ?: props.getProperty("blm.keystore.password")
            if (storePath != null && storePass != null) {
                storeFile = file(storePath)
                storePassword = storePass
                keyAlias = System.getenv("BLM_KEY_ALIAS")
                    ?: props.getProperty("blm.keystore.alias") ?: "xiaoqingting"
                keyPassword = storePass
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            val hasKey = signingConfigs.getByName("release").storeFile != null
            signingConfig = if (hasKey) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// renderer 产物同步：构建任何 APK 前先拷贝。
afterEvaluate {
    tasks.matching { it.name.startsWith("package") || it.name.startsWith("merge") }.configureEach {
        dependsOn(rootProject.projectDir.resolve("scripts/copy-renderer.gradle.kts").let {
            // apply 已注册的 copyRenderer 任务
            tasks.named("copyRenderer")
        })
    }
}
apply(from = "scripts/copy-renderer.gradle.kts")

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
