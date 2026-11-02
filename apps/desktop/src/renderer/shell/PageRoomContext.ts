import { createContext } from "react";

/** The editor reports its readable width without changing the writer's layout preferences. */
export const PageRoomContext = createContext<(width: number) => void>(() => {});
