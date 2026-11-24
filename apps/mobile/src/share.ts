import { File, Paths } from "expo-file-system";
import { Share } from "react-native";

/** Write the takes file to the cache and open the iOS share sheet; true when the writer shared it. */
export async function shareTakes(name: string, json: string): Promise<boolean> {
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  await file.write(json);
  try {
    const result = await Share.share({ url: file.uri, title: name });
    return result.action === Share.sharedAction;
  } finally {
    // The sheet has finished with the file by the time it closes, and the next share writes a fresh one. A file left
    // behind is only cache, so a failed delete must not replace the share's result.
    try { if (file.exists) file.delete(); } catch {}
  }
}
