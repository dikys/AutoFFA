import { FfaParticipant } from "./FfaParticipant";
import { createResourcesAmount, ResourcesAmount } from "library/common/primitives";
import { createGameMessageWithSound, broadcastMessage } from "library/common/messages";
import { DiplomacyStatus } from "library/game-logic/horde-types";
import { DiplomacyManager } from "./DiplomacyManager";
import { AutoFFASettings } from "./AutoFFASettings";

/**
 * Представляет команду (альянс), состоящую из сюзерена и его вассалов.
 * Управляет дипломатией всей команды, распределением ресурсов и продвижением участников.
 */
export class Team {
    // ==================================================================================================
    // Публичные свойства
    // ==================================================================================================

    public readonly id: number;
    public peaceUntilTick: number = 0;

    // ==================================================================================================
    // Приватные свойства
    // ==================================================================================================

    private _suzerain: FfaParticipant;
    private _vassals: Map<number, FfaParticipant> = new Map();
    private readonly settings: AutoFFASettings;

    // ==================================================================================================
    // Конструктор
    // ==================================================================================================

    constructor(id: number, initialSuzerain: FfaParticipant, settings: AutoFFASettings) {
        this.id = id;
        this._suzerain = initialSuzerain;
        this._suzerain.teamId = this.id;
        this._suzerain.suzerain = null;
        this.settings = settings;
    }

    // ==================================================================================================
    // Публичные геттеры
    // ==================================================================================================

    public get suzerain(): FfaParticipant {
        return this._suzerain;
    }

    public get vassals(): FfaParticipant[] {
        return Array.from(this._vassals.values());
    }

    /**
     * Возвращает всех членов команды, включая сюзерена и вассалов.
     * @returns {FfaParticipant[]} Массив всех членов команды.
     */
    public getMembers(): FfaParticipant[] {
        return [this._suzerain, ...this.vassals];
    }

    /**
     * Возвращает общее количество членов в команде.
     * @returns {number} Количество членов команды.
     */
    public getMemberCount(): number {
        return 1 + this._vassals.size;
    }

    /**
     * Рассчитывает общую мощь команды.
     * @returns {number} Суммарная мощь всех членов команды.
     */
    public getPower(): number {
        return this.getMembers().reduce((sum, member) => sum + member.getCurrentPower(), 0);
    }

    // ==================================================================================================
    // Публичные методы
    // ==================================================================================================

    /**
     * Добавляет нового вассала в команду.
     * @param {FfaParticipant} vassal - Участник, которого нужно добавить в качестве вассала.
     */
    public addVassal(vassal: FfaParticipant): void {
        this._vassals.set(vassal.id, vassal);
        vassal.teamId = this.id;
        vassal.suzerain = this._suzerain;

        this.updateDiplomacyOnJoin(vassal);

        if (vassal.isDefeated) {
            vassal.respawnCastle();
            const msg = createGameMessageWithSound(`Ваш новый сюзерен, ${this.suzerain.name}, приветствует вас. Вам предоставлен новый замок.`, this.suzerain.settlement.SettlementColor);
            vassal.settlement.Messages.AddMessage(msg);
        }
    }

    /**
     * Добавляет побежденного сюзерена и всех его вассалов в эту команду.
     * @param {FfaParticipant} formerSuzerain - Сюзерен побежденной команды.
     * @param {FfaParticipant[]} formerVassals - Вассалы побежденной команды.
     */
    public addSuzerainAndVassals(formerSuzerain: FfaParticipant, formerVassals: FfaParticipant[]): void {
        this.addVassal(formerSuzerain);
        for (const vassal of formerVassals) {
            this.addVassal(vassal);
        }
    }

    /**
     * Проверяет, следует ли повысить более могущественного вассала до сюзерена.
     */
    public promoteNewSuzerainIfNeeded(): void {
        const mostPowerfulMember = this.getMembers().reduce((prev, current) => 
            (prev.powerPoints > current.powerPoints) ? prev : current
        );

        if (mostPowerfulMember.id !== this._suzerain.id) {
            const oldSuzerain = this._suzerain;
            this.changeSuzerain(mostPowerfulMember);
            broadcastMessage(`Сюзерен ${oldSuzerain.name} уступил более влиятельному ${mostPowerfulMember.name}!`, this.suzerain.settlement.SettlementColor);
        }
    }

    /**
     * Распределяет ресурсы от щедрого сюзерена его вассалам.
     */
    public distributeGenerosity(): void {
        if (this._vassals.size === 0) return;

        const suzerainRes = this._suzerain.settlement.Resources;
        const generosity = createResourcesAmount(
            Math.max(0, suzerainRes.Gold - this.settings.suzerainGenerosityThreshold),
            Math.max(0, suzerainRes.Metal - this.settings.suzerainGenerosityThreshold),
            Math.max(0, suzerainRes.Lumber - this.settings.suzerainGenerosityThreshold),
            0
        );

        if (generosity.Gold === 0 && generosity.Metal === 0 && generosity.Lumber === 0) return;

        const sharePerVassal = createResourcesAmount(
            Math.floor(generosity.Gold / this._vassals.size),
            Math.floor(generosity.Metal / this._vassals.size),
            Math.floor(generosity.Lumber / this._vassals.size),
            0
        );

        if (sharePerVassal.Gold === 0 && sharePerVassal.Metal === 0 && sharePerVassal.Lumber === 0) return;

        let totalGiven = createResourcesAmount(0, 0, 0, 0);
        for (const vassal of this.vassals) {
            const payment = createResourcesAmount(
                Math.max(0, Math.min(sharePerVassal.Gold, this.settings.vassalResourceLimit - vassal.settlement.Resources.Gold)),
                Math.max(0, Math.min(sharePerVassal.Metal, this.settings.vassalResourceLimit - vassal.settlement.Resources.Metal)),
                Math.max(0, Math.min(sharePerVassal.Lumber, this.settings.vassalResourceLimit - vassal.settlement.Resources.Lumber)),
                0
            );
            if (payment.Gold > 0 || payment.Metal > 0 || payment.Lumber > 0) {
                vassal.receiveResources(payment);
                totalGiven.Add(payment);
            }
        }

        if (totalGiven.Gold > 0 || totalGiven.Metal > 0 || totalGiven.Lumber > 0) {
            this._suzerain.settlement.Resources.TakeResources(totalGiven);
        }
    }

    /**
     * Распределяет трофеи победы (очки силы) между членами команды.
     * @param {FfaParticipant} defeated - Участник, который был побежден.
     * @param {number} takenPercentage - Процент забираемых очков силы.
     */
    public shareSpoils(defeated: FfaParticipant, takenPercentage: number): void {
        const distributedPower = defeated.powerPoints * takenPercentage;
        defeated.powerPoints -= distributedPower;

        const members = this.getMembers();
        const totalDamage = members.reduce((sum, member) => sum + Math.max(1, member.damageDealtTo.get(defeated.id) || 0), 0);

        for (const member of members) {
            const damageShare = Math.max(1, member.damageDealtTo.get(defeated.id) || 0) / totalDamage;
            const gain = distributedPower * damageShare;
            member.powerPoints += gain;

            const msg = createGameMessageWithSound(`За победу над ${defeated.name} вам начислено ${Math.round(gain)} очков силы (ваша доля составляет ${Math.round(damageShare * 100)} %).`, member.settlement.SettlementColor);
            member.settlement.Messages.AddMessage(msg);
            member.damageDealtTo.set(defeated.id, 0); // Сбрасываем счетчик урона
        }
    }

    /**
     * Устанавливает мирный договор (нейтральную дипломатию) со всеми другими командами.
     * @param {Team[]} allTeams - Список всех команд в игре.
     */
    public setPeaceStatusWithAll(allTeams: Team[]): void {
        this.setDiplomacyWithAll(allTeams, DiplomacyStatus.Neutral);
    }

    /**
     * Объявляет войну всем другим командам.
     * @param {Team[]} allTeams - Список всех команд в игре.
     */
    public setWarStatusWithAll(allTeams: Team[]): void {
        this.setDiplomacyWithAll(allTeams, DiplomacyStatus.War);
    }

    // ==================================================================================================
    // Приватные методы
    // ==================================================================================================

    /**
     * Меняет сюзерена команды.
     * @param {FfaParticipant} newSuzerain - Участник, который станет новым сюзереном.
     */
    private changeSuzerain(newSuzerain: FfaParticipant): void {
        const oldSuzerain = this._suzerain;

        // Новый сюзерен больше не является вассалом
        this._vassals.delete(newSuzerain.id);
        newSuzerain.suzerain = null;

        // Старый сюзерен становится вассалом
        this._vassals.set(oldSuzerain.id, oldSuzerain);
        oldSuzerain.suzerain = newSuzerain;

        // Обновляем ссылку на сюзерена команды
        this._suzerain = newSuzerain;

        // Обновляем сюзерена для всех остальных вассалов
        for (const vassal of this.vassals) {
            if (vassal.id !== oldSuzerain.id) {
                vassal.suzerain = newSuzerain;
            }
        }
    }

    /**
     * Устанавливает дипломатический статус между этой командой и списком других команд.
     * @param {Team[]} otherTeams - Список команд, с которыми нужно установить дипломатию.
     * @param {DiplomacyStatus} status - Устанавливаемый дипломатический статус.
     */
    private setDiplomacyWithAll(otherTeams: Team[], status: DiplomacyStatus): void {
        for (const otherTeam of otherTeams) {
            if (this.id === otherTeam.id) continue;

            for (const member of this.getMembers()) {
                for (const otherMember of otherTeam.getMembers()) {
                    DiplomacyManager.setDiplomacy(member, otherMember, status);
                }
            }
        }
    }

    /**
     * Обновляет дипломатический статус для нового члена, вступающего в команду.
     * Он становится союзником со всеми существующими членами.
     * @param {FfaParticipant} newMember - Новый участник.
     */
    private updateDiplomacyOnJoin(newMember: FfaParticipant): void {
        for (const member of this.getMembers()) {
            if (newMember.id !== member.id) {
                DiplomacyManager.setDiplomacy(newMember, member, DiplomacyStatus.Alliance);
            }
        }
    }
}
