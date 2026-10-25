import { spawn } from "node:child_process";

// Enumerate the Windows SAPI voices (and a dev fallback elsewhere).

export const DEFAULT_VOICE = "Microsoft Huihui Desktop";

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve(out);
    }, 10000);
  });
}

export async function listVoices(): Promise<{ name: string; culture: string }[]> {
  if (process.platform !== "win32") {
    // Dev fallback (Linux/macOS): Windows isn't present.
    return [
      { name: DEFAULT_VOICE, culture: "zh-CN" },
      { name: "Microsoft Kangkang Desktop", culture: "zh-CN" },
    ];
  }
  const out = await runPowerShell(
    [
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }",
    ].join("; "),
  );
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("|"))
    .map((l) => {
      const [name, culture] = l.split("|");
      return { name, culture: culture ?? "" };
    });
}
