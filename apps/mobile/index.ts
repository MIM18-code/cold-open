import "react-native-get-random-values";
import { registerRootComponent } from "expo";
import { randomUUID } from "expo-crypto";
import { setIdGenerator } from "@screenplay/engine";
import App from "./App";

setIdGenerator(randomUUID);
registerRootComponent(App);
