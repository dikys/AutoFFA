import { activePlugins } from "active-plugins";
import { AutoFfaPlugin } from "./AutoFFAPlugin";
import { AutoFFASettings } from "./AutoFFASettings"; // Импортируем новый класс

/**
 * Вызывается до вызова "onFirstRun()" при первом запуске скрипт-машины, а так же при hot-reload
 */
export function onInitialization() {
    // Создаем экземпляр настроек прямо из класса.
    // Хост может менять значения в файле AutoFFASettings.ts
    const settings = new AutoFFASettings();

    // Передаем настройки в конструктор плагина
    activePlugins.register(new AutoFfaPlugin(settings));
}
