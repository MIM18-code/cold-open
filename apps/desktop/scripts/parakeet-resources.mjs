// Stage only the files needed by FluidAudio's int8-v2 Parakeet recognizer. Every byte comes from a pinned release.
import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sha256File } from "../../../scripts/prepare-native-source.mjs";

const { revision, files } = JSON.parse(readFileSync(new URL("./parakeet-files.json", import.meta.url), "utf8"));
const source = "https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml";
const notice = `Parakeet TDT 0.6B v3 by NVIDIA (https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3).
Core ML conversion and int8-v2 encoder by FluidInference: ${source}/tree/${revision}
Licensed under Creative Commons Attribution 4.0 International: https://creativecommons.org/licenses/by/4.0/
Cold Open redistributes the required Core ML components and vocabulary unchanged.
`;

export async function verifyParakeet(folder) {
  for (const [name, digest] of Object.entries(files)) {
    if (await sha256File(join(folder, name)) !== digest) throw new Error(`Parakeet checksum mismatch: ${name}`);
  }
  if (readFileSync(join(folder, "NOTICE.txt"), "utf8") !== notice) throw new Error("Missing Parakeet attribution.");
}

export async function stageParakeet(folder) {
  const cache = join(homedir(), "Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3");
  for (const [name, digest] of Object.entries(files)) {
    const dest = join(folder, name), cached = join(cache, name);
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(cached) && await sha256File(cached) === digest) {
      copyFileSync(cached, dest, constants.COPYFILE_FICLONE);
    } else {
      execFileSync("/usr/bin/curl", ["-q", "--fail", "--show-error", "--silent", "--location", "--proto", "=https",
        "--proto-redir", "=https", "--retry", "2", "--connect-timeout", "20", "--max-time", "1800",
        "--output", dest, `${source}/resolve/${revision}/${name}`]);
    }
  }
  writeFileSync(join(folder, "NOTICE.txt"), notice);
  await verifyParakeet(folder);
}
