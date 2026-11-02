// Window-level commands: the command palette, switching views, showing panels, appearance, and the Settings window.
import { useState } from "react";

import { app, type Command, type Feature, type ModalProps } from "../../core/app.ts";
import { useApp, useSetting } from "../../core/hooks.ts";

function applyTheme(theme: string) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function AppearanceSettings() {
  const [theme, setTheme] = useSetting("appearance.theme", "system");
  return (
    <label className="field">
      <span>Appearance</span>
      <select value={theme} onChange={(event) => (setTheme(event.target.value), applyTheme(event.target.value))}>
        <option value="system">Match the system</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

function SettingsModal({ props }: ModalProps<{ section?: string } | undefined>) {
  const sections = useApp((a) => a.settingsSections);
  const [current, setCurrent] = useState(props?.section ?? sections[0]?.id);
  const section = sections.find((s) => s.id === current) ?? sections[0];
  const Body = section?.component;
  return (
    <div className="workspace-settings">
      <nav>
        {sections.map((s) => (
          <button key={s.id} type="button" className={`list-row ${s.id === section?.id ? "on" : ""}`} aria-current={s.id === section?.id ? "page" : undefined} onClick={() => setCurrent(s.id)}>{s.title}</button>
        ))}
      </nav>
      <section>{Body ? <Body /> : null}</section>
    </div>
  );
}

// View and panel commands are built from whatever features registered, so they are computed on demand.
const dynamicCommands = (): Command[] => [
  ...app.views.map((view, index): Command => ({
    id: `view.${view.id}`, label: view.title, menu: "View", group: "views",
    // Cmd+1-9 belong to element types (as in Final Draft), so views use Ctrl+Cmd.
    ...(index < 9 ? { accelerator: `Ctrl+Cmd+${index + 1}` } : {}),
    checked: (a) => a.ui.view === view.id,
    run: (a) => a.setView(view.id),
  })),
  ...app.panels.map((panel): Command => ({
    id: `panel.${panel.id}`, label: `Show ${panel.title}`, menu: "View", group: `panels-${panel.side}`,
    checked: (a) => a.ui.leftPanel === panel.id || a.ui.rightPanel === panel.id,
    run: (a) => a.togglePanel(panel.id),
  })),
];

const feature: Feature = {
  id: "workspace",
  commands: [
    { id: "workspace.palette", label: "Command Palette…", menu: "Tools", group: "palette", accelerator: "CmdOrCtrl+K", hidden: true,
      run: (a) => a.setPalette(!a.ui.paletteOpen) },
    { id: "workspace.palette2", label: "Command Palette", accelerator: "CmdOrCtrl+Shift+P", hidden: true, run: (a) => a.setPalette(!a.ui.paletteOpen) },
    { id: "workspace.settings", label: "Settings…", menu: "Tools", group: "settings", accelerator: "CmdOrCtrl+,", run: (a) => a.openModal("workspace.settings") },
    { id: "workspace.leftSidebar", label: "Toggle Left Sidebar", menu: "View", group: "sidebars", accelerator: "CmdOrCtrl+Alt+S",
      run: (a) => a.togglePanel(a.ui.leftPanel ?? a.panels.find((p) => p.side === "left")?.id ?? "") },
    { id: "workspace.rightSidebar", label: "Toggle Right Sidebar", menu: "View", group: "sidebars", accelerator: "CmdOrCtrl+Alt+R",
      run: (a) => a.togglePanel(a.ui.rightPanel ?? a.panels.find((p) => p.side === "right")?.id ?? "") },
  ],
  modals: [{ id: "workspace.settings", title: "Settings", width: 760, component: SettingsModal }],
  settings: [{ id: "appearance", title: "Appearance", order: 0, component: AppearanceSettings }],
  activate(a) {
    feature.commands!.push(...dynamicCommands());
    applyTheme(a.setting("appearance.theme", "system"));
  },
};

export default feature;
