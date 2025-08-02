import { FfaParticipant } from "./FfaParticipant";
import { DiplomacyStatus } from "library/game-logic/horde-types";

/**
 * Централизованный менеджер для управления дипломатическими отношениями.
 * Гарантирует, что все изменения всегда двусторонние.
 */
export class DiplomacyManager {
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

    public static setDiplomacy(p1: FfaParticipant, p2: FfaParticipant, status: DiplomacyStatus) {
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