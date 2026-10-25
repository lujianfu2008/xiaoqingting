// 用法: npm i --prefix /tmp/icon-gen sharp 后  node build/gen-icon.js
// 依赖: sharp(临时装在 /tmp/icon-gen,见 plan);改 icon.svg 后重新运行本脚本,
// 生成 icon.png(512) + icon.ico(16-256 多尺寸)。无需保留在 dependencies 中。
// One-off icon generator: build/icon.svg -> build/icon.png (512) + build/icon.ico.
// ICO: ICONDIR + ICONDIRENTRYs + embedded PNGs (Vista+ supports PNG payloads).
const sharp = require("sharp");
const fs = require("node:fs");
const path = require("node:path");

const BUILD = "/home/ubuntu/mytool/packages/desktop/build";
const svg = fs.readFileSync(path.join(BUILD, "icon.svg"));

(async () => {
  // 512 master PNG (electron-builder can also auto-convert from this alone).
  // viewBox is 200 units → density = 72 * target / 200.
  await sharp(svg, { density: (72 * 512) / 200 })
    .resize(512, 512)
    .png()
    .toFile(path.join(BUILD, "icon.png"));

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) {
    pngs.push(
      await sharp(svg, { density: (72 * s) / 200 })
        .resize(s, s)
        .png()
        .toBuffer(),
    );
  }

  const entries = [];
  let offset = 6 + 16 * pngs.length;
  pngs.forEach((png, i) => {
    const s = sizes[i];
    const dir = Buffer.alloc(16);
    dir.writeUInt8(s >= 256 ? 0 : s, 0); // width (0 = 256)
    dir.writeUInt8(s >= 256 ? 0 : s, 1);
    dir.writeUInt8(0, 2); // palette colors
    dir.writeUInt8(0, 3); // reserved
    dir.writeUInt16LE(1, 4); // planes
    dir.writeUInt16LE(32, 6); // bpp
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    entries.push(dir);
    offset += png.length;
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon type
  header.writeUInt16LE(pngs.length, 4);

  fs.writeFileSync(path.join(BUILD, "icon.ico"), Buffer.concat([header, ...entries, ...pngs]));

  for (const f of ["icon.png", "icon.ico"]) {
    console.log(f, fs.statSync(path.join(BUILD, f)).size, "bytes");
  }
})();
