// Fixed-page HTML/SVG is rendered in a network-isolated window. This supports direct PDF output with
// the system's fallback fonts without replacing unsupported characters with question marks.
import { BrowserWindow, session } from "electron";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PRINT_CHANNELS, validPrintRequest, type PrintRequest, type PrintResult } from "../../shared/channels/print.ts";
import type { ServiceContext } from "../context.ts";
import { writeNewFile } from "../safe-fs.ts";

const MICRONS_PER_INCH = 25_400;
const PREFIX = "screenplay-print-";
let printSession: Electron.Session | undefined;
function pagesSession(): Electron.Session {
  if (printSession) return printSession;
  const allowed = pathToFileURL(join(tmpdir(), PREFIX)).href;
  printSession = session.fromPartition("print");
  printSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(allowed) }));
  return printSession;
}
let active = 0;
async function render(request: PrintRequest, pdfOnly: boolean): Promise<PrintResult | Uint8Array> {
  if (++active > 3) { active--; throw new Error("Three print jobs are already active. Finish or cancel one before starting another."); }
  const file=join(tmpdir(),`${PREFIX}${randomUUID()}.html`);
  let window: BrowserWindow | undefined;
  try {
    await writeNewFile(file,request.html,0o600);
    window=new BrowserWindow({ show:false,width:Math.round(request.width*96),height:Math.round(request.height*96),title:request.title,
      webPreferences:{session:pagesSession(),sandbox:true,contextIsolation:true,nodeIntegration:false,javascript:false,spellcheck:false} });
    window.webContents.on("will-navigate",(event)=>event.preventDefault());
    window.webContents.setWindowOpenHandler(()=>({action:"deny"}));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([window.loadFile(file),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error("The print page did not finish loading.")),30000);})]);
    } finally {clearTimeout(timeout);}
    if(pdfOnly||process.env.SCREENPLAY_E2E){
      const pdf=await window.webContents.printToPDF({preferCSSPageSize:true,printBackground:true,margins:{top:0,bottom:0,left:0,right:0},generateTaggedPDF:true});
      if(pdf.length>64*1024*1024)throw new Error("The PDF exceeds the output limit. Export a smaller range.");
      return pdfOnly?new Uint8Array(pdf):{printed:false,reason:"test",testBytes:pdf.length};
    }
    const pageSize={width:Math.round(request.width*MICRONS_PER_INCH),height:Math.round(request.height*MICRONS_PER_INCH)};
    return await new Promise<PrintResult>((resolve)=>window!.webContents.print({silent:false,printBackground:false,margins:{marginType:"none"},pageSize},
      (printed,reason)=>resolve({printed,...(reason?{reason}:{})})));
  } finally {window?.destroy();await rm(file,{force:true}).catch(()=>undefined);active--;}
}
export function register(ctx: ServiceContext): void {
  ctx.handle(PRINT_CHANNELS.print,async(_event,request:unknown)=>{if(!validPrintRequest(request))throw new Error("Nothing to print.");return render(request,false);});
  ctx.handle("print:pdf",async(_event,request:unknown)=>{if(!validPrintRequest(request))throw new Error("Invalid PDF pages.");return render(request,true);});
}
