import { activePlugins } from "active-plugins";
import { AutoFFAPlugin } from "./AutoFFAPlugin";

/**
 * Вызывается до вызова "onFirstRun()" при первом запуске скрипт-машины, а так же при hot-reload
 */
export function onInitialization() {
    activePlugins.register(new AutoFFAPlugin());
}
