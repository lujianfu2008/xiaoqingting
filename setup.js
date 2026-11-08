#!/usr/bin/env node
// 一键安装脚本：依赖安装 + 环境模板复制 + 基础校验
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const PKG_SERVER = path.join(ROOT, 'packages', 'server');
const ENV_EXAMPLE = path.join(PKG_SERVER, '.env.example');
const ENV_TARGET = path.join(PKG_SERVER, '.env');

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`❌ 命令失败: ${cmd} ${args.join(' ')}`);
    process.exit(r.status);
  }
  return r;
}

console.log('🚀 Xiaoqingting 一键安装开始...\n');

// 1. npm install
console.log('📦 1/4 安装依赖...');
run('npm', ['install']);

// 2. 复制 .env.example -> .env
console.log('\n⚙️ 2/4 生成环境配置模板...');
if (!fs.existsSync(ENV_EXAMPLE)) {
  console.error('❌ 找不到 .env.example');
  process.exit(1);
}
if (!fs.existsSync(ENV_TARGET)) {
  fs.copyFileSync(ENV_EXAMPLE, ENV_TARGET);
  console.log('✅ 已创建 packages/server/.env（请务必编辑填入 Key）');
} else {
  console.log('⚠️ packages/server/.env 已存在，跳过覆盖');
}

// 3. 基础校验
console.log('\n🔍 3/4 环境校验...');
const envContent = fs.readFileSync(ENV_TARGET, 'utf8');
const required = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'JWT_SECRET', 'BLMA_USERNAME', 'BLMA_PASSWORD'];
let missing = [];
required.forEach(k => {
  const re = new RegExp(`^${k}=(.+)$`, 'm');
  if (!re.test(envContent) || re.exec(envContent)[1].trim() === '' || re.exec(envContent)[1].includes('your-')) {
    missing.push(k);
  }
});
if (missing.length) {
  console.log(`⚠️ 以下必填项尚未配置，请编辑 ${ENV_TARGET}：`);
  missing.forEach(k => console.log(`   - ${k}`));
} else {
  console.log('✅ 核心环境变量已填写');
}

// 4. 提示离线 ASR 模型
console.log('\n🎤 4/4 离线 ASR 模型（可选，约 80 MB）');
const modelDir = path.join(ROOT, 'packages', 'desktop', 'models', 'sherpa-onnx-paramformer');
const modelFiles = ['model.int8.onnx', 'tokens.txt', 'am.mvn'];
const hasModel = modelFiles.every(f => fs.existsSync(path.join(modelDir, f)));
if (hasModel) {
  console.log('✅ 模型文件已就位');
} else {
  console.log('⚠️ 未检测到模型文件，语音识别将不可用');
  console.log('   下载地址: https://github.com/k2-fsa/sherpa-onnx/releases (搜 sherpa-onnx-paramformer-zh-small)');
  console.log(`   解压到: ${modelDir}`);
}

console.log('\n🎉 安装完成！');
console.log('\n下一步：');
console.log('  1. 编辑 packages/server/.env 填入上游 Key');
console.log('  2. 终端 A: npm run dev:server   (启动服务端 http://localhost:8788)');
console.log('  3. 终端 B: npm run dev:desktop  (启动桌面端)');
console.log('\n   或 Windows 双击 start-all.bat 一键后台启动');