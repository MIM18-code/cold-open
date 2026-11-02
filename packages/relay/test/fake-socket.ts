export class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  constructor(_url: string) { FakeSocket.instances.push(this); }
  send(_data: Uint8Array) {}
  close(code = 1006, reason = "interrupted") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}
