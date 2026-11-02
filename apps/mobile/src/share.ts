import { File, Paths } from "expo-file-system";
import { Share } from "react-native";

/** Write the takes file to the cache and open the iOS share sheet; true when the writer shared it. */
export async function shareTakes(name: string, json: string): Promise<boolean> {
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  await file.write(json);
  const result = await Share.share({ url: file.uri, title: name });
  return result.action === Share.sharedAction;
}
