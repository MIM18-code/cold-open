import { moveLocation } from "../../core/location-history.ts";
import type { App, Feature } from "../../core/app.ts";
function navigate(a: App, direction: -1 | 1): void {
    const session = a.session;
    a.setView("script");
    const perform = () => {
        if (a.session !== session)
            return true;
        if (!a.editor)
            return false;
        if (!moveLocation(session, a.editor, direction))
            a.toast(direction < 0 ? "No earlier surviving location in this document." : "No later surviving location in this document.");
        return true;
    };
    if (perform())
        return;
    const off = a.subscribe(() => { if (perform()) {
        off();
        clearTimeout(timer);
    } });
    const timer = setTimeout(off, 2000);
}
const feature: Feature = { id: "locations", commands: [
        { id: "locations.back", label: "Back to Previous Location", menu: "View", group: "locations", accelerator: "CmdOrCtrl+Alt+Left", run: a => navigate(a, -1) },
        { id: "locations.forward", label: "Forward to Next Location", menu: "View", group: "locations", accelerator: "CmdOrCtrl+Alt+Right", run: a => navigate(a, 1) },
    ] };
export default feature;
