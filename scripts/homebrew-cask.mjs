// Write the Homebrew cask for the released DMG into a checkout of MIM18-code/homebrew-cold-open.
// Usage: node scripts/homebrew-cask.mjs <homebrew-cold-open checkout>
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tap = process.argv[2];
if (!tap) { console.error('usage: node scripts/homebrew-cask.mjs <homebrew-cold-open checkout>'); process.exit(2); }
const { version } = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'));
const dmg = join(root, 'release/public', `ColdOpen-${version}.dmg`);
if (!existsSync(dmg)) { console.error(`missing ${dmg}; run npm run release:prepare first`); process.exit(1); }
const sha256 = createHash('sha256').update(readFileSync(dmg)).digest('hex');
const cask = `cask "cold-open" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/MIM18-code/cold-open/releases/download/v#{version}/ColdOpen-#{version}.dmg"
  name "Cold Open"
  desc "Screenwriting app that opens and saves Final Draft files"
  homepage "https://github.com/MIM18-code/cold-open"

  # Beta versions: the default GitHub strategies read only plain x.y.z tags.
  livecheck do
    url "https://github.com/MIM18-code/cold-open/releases/latest"
    regex(%r{/tag/v?(\\d+(?:\\.\\d+)+(?:-beta\\.\\d+)?)$}i)
    strategy :header_match
  end

  depends_on arch: :arm64
  depends_on macos: :sonoma

  app "Cold Open.app"

  zap trash: [
    "~/Library/Application Support/Cold Open",
    "~/Library/Application Support/Inklot",
    "~/Library/Preferences/tv.mindinmotion.inklot.plist",
    "~/Library/Saved Application State/tv.mindinmotion.inklot.savedState",
  ]
end
`;
mkdirSync(join(tap, 'Casks'), { recursive: true });
writeFileSync(join(tap, 'Casks', 'cold-open.rb'), cask);
console.log(`wrote ${join(tap, 'Casks/cold-open.rb')} for ${version} (${sha256.slice(0, 12)}…)`);
