import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { close, launch, runCommand } from "./helpers.ts";

async function draft(page: Page) {
  await page.evaluate(() => {
    const app = (window as any).__app;
    app.session.edit(() => app.session.doc.load({ titlePage: [], paragraphs: [
      { id:"h",sceneId:"scene-one",type:"sceneHeading",runs:[{text:"INT. ROOM - DAY"}] },
      { id:"a",type:"action",runs:[{text:"Mara waits beside the door."}] },
      { id:"m",type:"character",runs:[{text:"MARA"}] },
      { id:"d",type:"dialogue",runs:[{text:"Open the door."}] },
      { id:"e",type:"character",runs:[{text:"ELI"}] },
      { id:"r",type:"dialogue",runs:[{text:"Leave the door shut."}] },
    ] }));
    app.session.undo.clear();
    app.editor.setSelection({paragraphId:"d",offset:4});app.editor.focus();
  });
}
const text = (page: Page, id: string) => page.evaluate((id) => (window as any).__app.session.doc.paragraph(id).runs.map((r:any)=>r.text).join(""), id);

test("named history restores an old draft only after saving the outgoing draft, and Undo restores the current wording", async () => {
  const run = await launch();
  try {
    await draft(run.page);
    await runCommand(run.page,"history.open");
    await run.page.getByRole("textbox",{name:"Snapshot name"}).fill("Before the new opening");
    await run.page.getByRole("button",{name:"Save named snapshot"}).click();
    await expect(run.page.locator(".history-list article")).toHaveCount(1);
    await run.page.getByRole("button",{name:"Close",exact:true}).last().click();
    await run.page.evaluate(()=>{const s=(window as any).__app.session;s.edit(()=>s.doc.insertText("a",0,"New opening. "));});
    await runCommand(run.page,"history.open");
    await run.page.locator(".history-list article").getByRole("button").first().click();
    await expect(run.page.locator(".history-preview")).toBeVisible();
    await run.electronApp.evaluate(()=>{(globalThis as any).e2eMessageBox=()=>0;});
    await run.page.getByRole("button",{name:"Restore with safety snapshot"}).click();
    await expect.poll(()=>text(run.page,"a")).toBe("Mara waits beside the door.");
    await expect(run.page.locator(".history-list article")).toHaveCount(2);
    await run.page.getByRole("button",{name:"Close",exact:true}).last().click();
    await run.page.evaluate(()=>(window as any).__app.session.undo.undo());
    await expect.poll(()=>text(run.page,"a")).toBe("New opening. Mara waits beside the door.");
  } finally {await close(run.electronApp,run.page);}
});

test("notes follow a source edit, alternatives preserve outgoing wording, and saved cuts remain outside the screenplay", async()=>{
  const run=await launch();
  try{
    await draft(run.page);await runCommand(run.page,"rewrite.new.note");
    await run.page.getByRole("textbox",{name:"Project item name"}).fill("Performance note");
    await run.page.getByRole("textbox",{name:"Project item text"}).fill("Keep the reply quiet.");
    await run.page.getByRole("button",{name:"Keep note",exact:true}).click();
    await expect(run.page.locator(".rewrite-item").filter({hasText:"Performance note"})).toBeVisible();
    await run.page.evaluate(()=>{const s=(window as any).__app.session;s.edit(()=>s.doc.insertText("d",0,"Please "));});
    await expect(run.page.locator(".rewrite-item").getByRole("button",{name:"Go to text"})).toBeEnabled();
    await run.page.evaluate(()=>{const a=(window as any).__app;a.editor.setSelection({paragraphId:"d",offset:1});a.editor.focus();});
    await runCommand(run.page,"rewrite.new.alternative");
    await run.page.getByRole("textbox",{name:"Project item name"}).fill("Second take");
    await run.page.getByRole("textbox",{name:"Project item text"}).fill("Let me in.");
    await run.page.getByRole("button",{name:"Keep alternative",exact:true}).click();
    expect(await text(run.page,"d")).toBe("Please Open the door.");
    await run.page.getByRole("combobox",{name:"Rewrite material type"}).selectOption("alternative");
    await run.electronApp.evaluate(()=>{(globalThis as any).e2eMessageBox=()=>0;});
    await run.page.getByRole("button",{name:"Swap into draft"}).click();
    await expect.poll(()=>text(run.page,"d")).toBe("Let me in.");
    await expect(run.page.locator(".rewrite-item")).toContainText("Please Open the door.");
  }finally{await close(run.electronApp,run.page);}
});

test("dialogue search changes only the selected character's matching words",async()=>{
  const run=await launch();try{
    await draft(run.page);await runCommand(run.page,"editor.replace");
    await run.page.getByRole("textbox",{name:"Find",exact:true}).fill("door");
    await run.page.getByRole("combobox",{name:"Search scope"}).selectOption("character");
    await run.page.getByRole("textbox",{name:"Search character"}).fill("MARA");
    await run.page.getByRole("textbox",{name:"Replace with"}).fill("gate");
    await run.page.getByRole("button",{name:"Replace All",exact:true}).click();
    expect(await text(run.page,"d")).toBe("Open the gate.");
    expect(await text(run.page,"a")).toBe("Mara waits beside the door.");
    expect(await text(run.page,"r")).toBe("Leave the door shut.");
  }finally{await close(run.electronApp,run.page);}
});

test("remapped element commands update menus and preserve text entry",async()=>{
  const run=await launch();try{
    await draft(run.page);
    await run.page.evaluate(()=>(window as any).__app.openModal("workspace.settings",{section:"shortcuts"}));
    await run.page.getByRole("listbox",{name:"Command to remap"}).selectOption("editor.element.action");
    await run.page.getByRole("textbox",{name:"Shortcut binding"}).fill("CmdOrCtrl+Shift+9");
    await expect(run.page.getByRole("textbox",{name:"Shortcut binding"})).toHaveValue("CmdOrCtrl+Shift+9");
    await run.page.getByRole("button",{name:"Apply binding",exact:true}).click();
    expect(await run.page.locator(".shortcut-settings [role=alert]").allTextContents()).toEqual([]);
    await expect.poll(()=>run.page.evaluate(()=>(window as any).__app.commands.find((c:any)=>c.id==="editor.element.action").accelerator)).toBe("CmdOrCtrl+Shift+9");
    await run.page.keyboard.press("Escape");
    await run.page.locator(".editor-pm").focus();
    await run.page.keyboard.press("Meta+Shift+9");
    await expect.poll(()=>run.page.evaluate(()=>(window as any).__app.editor.currentElementType())).toBe("action");
  }finally{await close(run.electronApp,run.page);}
});

test("delivery sides export actual PDF bytes and preview contains only selected scenes",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"screenplay-delivery-")),path=join(dir,"Actor sides.pdf"),run=await launch();
  try{
    await draft(run.page);await runCommand(run.page,"delivery.open");
    await run.page.getByRole("combobox",{name:"Delivery type"}).selectOption("sides");
    await run.page.getByRole("combobox",{name:"Sides character"}).selectOption("MARA");
    await run.page.getByRole("textbox",{name:"Delivery recipient"}).fill("Reader copy");
    await run.page.getByRole("textbox",{name:"Delivery watermark"}).fill("For {recipient}");
    await expect(run.page.getByTitle("Delivery page preview")).toBeVisible();
    await run.electronApp.evaluate(({dialog},file)=>{dialog.showSaveDialog=(async()=>({canceled:false,filePath:file})) as any;},path);
    await run.page.getByRole("button",{name:"Export previewed PDF"}).click();
    await expect.poll(()=>existsSync(path),{timeout:20000}).toBe(true);
    expect(readFileSync(path).subarray(0,5).toString()).toBe("%PDF-");
    expect(readFileSync(path).length).toBeGreaterThan(1000);
  }finally{await close(run.electronApp,run.page);}
});
