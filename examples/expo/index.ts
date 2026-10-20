import { registerRootComponent } from "expo";
import { installNativeCrypto } from "@lumen/react-native";
import App from "./src/App";

installNativeCrypto();
registerRootComponent(App);
