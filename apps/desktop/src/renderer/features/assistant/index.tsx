// The Ask panel (a chat about the script and, when a Backlot project is chosen, the production) and the AI
// section of Settings. Quick actions send nothing until clicked; the assistant never speaks unprompted.
import type { App, Feature } from "../../core/app.ts";
import { Boundary } from "./Boundary.tsx";
import { AssistantPanel, getChat } from "./Panel.tsx";
import { AiSettings } from "./Settings.tsx";
import "./assistant.css";

const askAbout = (kind: "notes" | "summarize" | "continuity") => (app: App) => {
  app.togglePanel("assistant", true);
  void getChat().quick(kind, { backlot: true });
};

const AskPanel = () => <Boundary label="Ask"><AssistantPanel /></Boundary>;
const AiSection = () => <Boundary label="AI settings"><AiSettings /></Boundary>;

const feature: Feature = {
  id: "assistant",
  panels: [{ id: "assistant", title: "Ask", side: "right", order: 60, component: AskPanel }],
  commands: [
    { id: "assistant.open", label: "Ask About the Script…", menu: "Tools", group: "ai", run: (app) => app.togglePanel("assistant") },
    { id: "assistant.notes", label: "Notes on This Scene", menu: "Tools", group: "ai", run: askAbout("notes") },
    { id: "assistant.summarize", label: "Summarize This Scene", menu: "Tools", group: "ai", run: askAbout("summarize") },
    { id: "assistant.continuity", label: "Find Continuity Issues", menu: "Tools", group: "ai", run: askAbout("continuity") },
  ],
  settings: [{ id: "ai", title: "AI", order: 40, component: AiSection }],
};

export default feature;
