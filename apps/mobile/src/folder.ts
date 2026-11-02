import { NativeModule, requireNativeModule } from "expo";
import { sha256 } from "./crypto";
import { folderItem, type Take } from "./outbox";
import type { Pairing } from "./pairing";

declare class Folder extends NativeModule {
  read(deviceId: string): Promise<string | null>;
  deviceName(): string;
  configured(): boolean;
  pick(): Promise<boolean>;
  write(deviceId: string, receiptId: string, json: string): Promise<void>;
}
export const phoneFolder = requireNativeModule<Folder>("InklotPhoneFolder");
export async function saveToFolder(pair: Pairing, take: Take) {
  await phoneFolder.write(pair.deviceId!, take.id, await folderItem(pair, take, sha256));
}
