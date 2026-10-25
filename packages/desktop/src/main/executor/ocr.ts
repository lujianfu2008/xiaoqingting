import { spawn } from "node:child_process";

// Local OCR for image attachments (read_attachment with mode "ocr"): uses
// Windows.Media.Ocr through PowerShell/WinRT — free, offline, zh-CN capable.
// Other platforms return a readable error for now (PaddleOCR later).
const OCR_TIMEOUT_MS = 25_000;

const PS_LINES = [
"$ErrorActionPreference = 'Stop'",
"Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null",
"$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]",
"$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]",
"$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]",
"$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
"function Await($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }",
"$avail = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages",
"$lang = $avail | Where-Object { $_.LanguageTag -like 'zh*' } | Select-Object -First 1",
"if (-not $lang) { $lang = $avail | Select-Object -First 1 }",
"$engine = if ($lang) { [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang) } else { [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }",
"if (-not $engine) { throw 'OCR engine unavailable' }",
"$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])",
"$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])",
"$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])",
"$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])",
"$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])",
// Write-Output goes through the console code page (GBK on zh-CN Windows) and
// Node decodes the pipe as UTF-8 — Chinese comes out as mojibake. Bypass the
// console entirely: emit the .NET string as raw UTF-8 bytes on stdout.
"$bytes = [System.Text.Encoding]::UTF8.GetBytes($result.Text)",
"[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)",
];

export function ocrImage(imagePath: string): Promise<{ ok: boolean; output?: string; error?: string }> {
return new Promise((resolve) => {
if (process.platform !== "win32") {
resolve({ ok: false, error: "当前系统暂不支持本地图片文字识别（仅 Windows）。" });
return;
}
// PowerShell single-quote literal: double embedded quotes.
const psPath = imagePath.replace(/'/g, "''");
const script = "$p = '" + psPath + "'\n" + PS_LINES.join("\n");
const child = spawn(
"powershell.exe",
["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
{ windowsHide: true },
);
let out = "";
let err = "";
const timer = setTimeout(() => {
child.kill("SIGKILL");
resolve({ ok: false, error: "图片文字识别超时。" });
}, OCR_TIMEOUT_MS);
child.stdout.on("data", (d) => {
out += String(d);
});
child.stderr.on("data", (d) => {
err += String(d);
});
child.on("error", (e) => {
clearTimeout(timer);
resolve({ ok: false, error: `OCR 启动失败：${e.message}` });
});
child.on("close", (code) => {
clearTimeout(timer);
const text = out.trim();
if (code === 0 && text) resolve({ ok: true, output: text });
else {
resolve({
ok: false,
error: err.trim() || `OCR 失败（退出码 ${code}），图片中可能没有可识别的文字。`,
});
}
});
});
}
