import { FfaParticipant } from "./FfaParticipant";
import { DiplomacyStatus } from "library/game-logic/horde-types";

/**
 * Централизованный менеджер для управления дипломатическими отношениями.
 * Гарантирует, что все изменения всегда двусторонние и кэширует статусы.
 */
export class DiplomacyManager {
    private static diplomacyCache: Map<string, DiplomacyStatus> = new Map();

    /**
     * Создает уникальный ключ для пары участников для использования в кэше.
     * Ключ не зависит от порядка участников.
     * @param p1 Первый участник.
     * @param p2 Второй участник.
     * @returns Строковый ключ.
     */
    private static getCacheKey(p1: FfaParticipant, p2: FfaParticipant): string {
        const uids = [p1.settlement.Uid, p2.settlement.Uid].sort();
        return uids.join('-');
    }

    /**
     * Получает дипломатический статус между двумя участниками, используя кэш.
     * Если статуса нет в кэше, запрашивает его у игры и сохраняет.
     * @param p1 Первый участник.
     * @param p2 Второй участник.
     * @returns Дипломатический статус.
     */
    public static getDiplomacyStatus(p1: FfaParticipant, p2: FfaParticipant): DiplomacyStatus {
        const key = this.getCacheKey(p1, p2);
        if (this.diplomacyCache.has(key)) {
            return this.diplomacyCache.get(key)!;
        }

        const status = p1.settlement.Diplomacy.GetDiplomacyStatus(p2.settlement);
        this.diplomacyCache.set(key, status);
        return status;
    }
    
    /**
     * Устанавливает мирные отношения между всеми участниками.
     * @param participants Все участники игры.
     */
    public static establishPeaceAmongAll(participants: FfaParticipant[]) {
        for (let i = 0; i < participants.length; i++) {
            for (let j = i + 1; j < participants.length; j++) {
                this.setDiplomacy(participants[i], participants[j], DiplomacyStatus.Neutral);
            }
        }
    }

    /**
     * Устанавливает дипломатические отношения между двумя участниками и обновляет кэш.
     * @param p1 Первый участник.
     * @param p2 Второй участник.
     * @param status Новый дипломатический статус.
     */
    public static setDiplomacy(p1: FfaParticipant, p2: FfaParticipant, status: DiplomacyStatus) {
        // Обновляем кэш
        const key = this.getCacheKey(p1, p2);
        this.diplomacyCache.set(key, status);

        // Устанавливаем отношения в игре
        switch (status) {
            case DiplomacyStatus.War:
                p1.settlement.Diplomacy.DeclareWar(p2.settlement);
                p2.settlement.Diplomacy.DeclareWar(p1.settlement);
                break;
            case DiplomacyStatus.Neutral:
                p1.settlement.Diplomacy.DeclarePeace(p2.settlement);
                p2.settlement.Diplomacy.DeclarePeace(p1.settlement);
                break;
            case DiplomacyStatus.Alliance:
                p1.settlement.Diplomacy.DeclareAlliance(p2.settlement);
                p2.settlement.Diplomacy.DeclareAlliance(p1.settlement);
                break;
        }
    }
}