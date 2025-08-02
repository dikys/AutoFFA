import { activePlugins } from "active-plugins";
import { AutoFfaPlugin } from "./AutoFFAPlugin";

/**
 * Вызывается до вызова "onFirstRun()" при первом запуске скрипт-машины, а так же при hot-reload
 */
export function onInitialization() {
    activePlugins.register(new AutoFfaPlugin());
}
