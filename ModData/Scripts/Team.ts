import { FfaParticipant } from "./FfaParticipant";
import { createResourcesAmount, ResourcesAmount } from "library/common/primitives";
import { createGameMessageWithSound, broadcastMessage } from "library/common/messages";
import { DiplomacyStatus } from "library/game-logic/horde-types";
import { DiplomacyManager } from "./DiplomacyManager";
import { AutoFFASettings } from "./AutoFFASettings";
import { log } from "library/common/logging";

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
        log.info(`Создана новая команда (id: ${this.id}) с сюзереном ${initialSuzerain.name}.`);
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
        log.info(`[Команда ${this.id}] Добавление вассала ${vassal.name} (id: ${vassal.id}) под сюзеренство ${this.suzerain.name}.`);
        this._vassals.set(vassal.id, vassal);
        vassal.teamId = this.id;
        vassal.suzerain = this._suzerain;
        vassal.target = this._suzerain.target; // Синхронизируем цель с сюзереном

        this.updateDiplomacyOnJoin(vassal);

        if (vassal.isDefeated) {
            log.info(`[Команда ${this.id}] Вассал ${vassal.name} побежден, возрождаем замок.`);
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
        log.info(`[Команда ${this.id}] Поглощение команды ${formerSuzerain.name}.`);
        this.addVassal(formerSuzerain);
        for (const vassal of formerVassals) {
            this.addVassal(vassal);
        }
    }

    /**
     * Удаляет вассала из команды.
     * @param {FfaParticipant} vassal - Участник, которого нужно удалить.
     * @returns {boolean} True, если вассал был найден и удален.
     */
    public removeVassal(vassal: FfaParticipant): boolean {
        if (this._vassals.has(vassal.id)) {
            log.info(`[Команда ${this.id}] Удаление вассала ${vassal.name} из команды.`);
            this._vassals.delete(vassal.id);
            vassal.suzerain = null; // Сбрасываем сюзерена
            return true;
        }
        return false;
    }

    /**
     * Проверяет, следует ли повысить более могущественного вассала до сюзерена.
     * @returns {boolean} True, если произошла смена сюзерена.
     */
    public promoteNewSuzerainIfNeeded(): boolean {
        const mostPowerfulMember = this.getMembers().reduce((prev, current) => 
            (prev.powerPoints > current.powerPoints) ? prev : current
        );

        if (mostPowerfulMember.id !== this._suzerain.id && this._suzerain.powerPoints + 10 < mostPowerfulMember.powerPoints) {
            const oldSuzerain = this._suzerain;
            log.info(`[Команда ${this.id}] Смена власти! ${mostPowerfulMember.name} (${Math.round(mostPowerfulMember.powerPoints)} очков) становится новым сюзереном, смещая ${oldSuzerain.name} (${Math.round(oldSuzerain.powerPoints)} очков).`);
            this.changeSuzerain(mostPowerfulMember);
            broadcastMessage(`Сюзерен ${oldSuzerain.name} уступил более влиятельному ${mostPowerfulMember.name}!`, this.suzerain.settlement.SettlementColor);
            return true;
        }
        return false;
    }

    /**
     * Распределяет ресурсы от щедрого сюзерена его вассалам.
     * @returns {boolean} True, если ресурсы были распределены.
     */
    public distributeGenerosity(): boolean {
        log.info("this._vassals.size = ", this._vassals.size);
        if (this._vassals.size === 0) return false;

        const suzerainRes = this._suzerain.settlement.Resources;
        const generosity = createResourcesAmount(
            Math.max(0, suzerainRes.Gold - this.settings.suzerainGenerosityThreshold),
            Math.max(0, suzerainRes.Metal - this.settings.suzerainGenerosityThreshold),
            Math.max(0, suzerainRes.Lumber - this.settings.suzerainGenerosityThreshold),
            0
        );

        if (generosity.Gold === 0 && generosity.Metal === 0 && generosity.Lumber === 0) return false;

        log.info(`[Команда ${this.id}] Сюзерен ${this.suzerain.name} проявляет щедрость. Доступно для распределения: ${generosity.Gold}G, ${generosity.Metal}M, ${generosity.Lumber}L.`);

        const sharePerVassal = createResourcesAmount(
            Math.floor(generosity.Gold / this._vassals.size),
            Math.floor(generosity.Metal / this._vassals.size),
            Math.floor(generosity.Lumber / this._vassals.size),
            0
        );

        if (sharePerVassal.Gold === 0 && sharePerVassal.Metal === 0 && sharePerVassal.Lumber === 0) {
            log.info(`[Команда ${this.id}] Доля на одного вассала слишком мала для распределения.`);
            return false;
        }

        let totalGiven = createResourcesAmount(0, 0, 0, 0);
        for (const vassal of this.vassals) {
            const payment = createResourcesAmount(
                Math.max(0, Math.min(sharePerVassal.Gold, this.settings.vassalResourceLimit - vassal.settlement.Resources.Gold)),
                Math.max(0, Math.min(sharePerVassal.Metal, this.settings.vassalResourceLimit - vassal.settlement.Resources.Metal)),
                Math.max(0, Math.min(sharePerVassal.Lumber, this.settings.vassalResourceLimit - vassal.settlement.Resources.Lumber)),
                0
            );
            if (payment.Gold > 0 || payment.Metal > 0 || payment.Lumber > 0) {
                log.info(`[Команда ${this.id}] -> Вассал ${vassal.name} получает ${payment.Gold}G, ${payment.Metal}M, ${payment.Lumber}L.`);
                vassal.receiveResources(payment);
                totalGiven.Add(payment);

                // Новая логика обмена очками силы
                if (this.settings.enablePowerPointsExchange) {
                    const totalResourceValue = payment.Gold + payment.Metal + payment.Lumber;
                    if (totalResourceValue > 0) {
                        const pointsToTransfer = totalResourceValue * this.settings.powerPointsExchangeRate;
                        // Вассал отдает очки сюзерену за щедрость
                        const actualPointsTransferred = Math.min(vassal.powerPoints, pointsToTransfer);
                        if (actualPointsTransferred > 0) {
                            log.info(`[Команда ${this.id}] Обмен очками: ${vassal.name} (-${Math.round(actualPointsTransferred)}) -> ${this._suzerain.name} (+${Math.round(actualPointsTransferred)}).`);
                            vassal.powerPoints -= actualPointsTransferred;
                            this._suzerain.powerPoints += actualPointsTransferred;

                            // Отслеживаем обмен
                            vassal.totalPointsFromGenerosity -= actualPointsTransferred;
                            this._suzerain.totalPointsFromGenerosity += actualPointsTransferred;
                        }
                    }
                }
            }
        }

        if (totalGiven.Gold > 0 || totalGiven.Metal > 0 || totalGiven.Lumber > 0) {
            log.info(`[Команда ${this.id}] Сюзерен ${this.suzerain.name} всего распределил: ${totalGiven.Gold}G, ${totalGiven.Metal}M, ${totalGiven.Lumber}L.`);
            this._suzerain.settlement.Resources.TakeResources(totalGiven);
            return true;
        }
        return false;
    }

    /**
     * Распределяет трофеи победы (очки силы) между членами команды.
     * @param {FfaParticipant} defeated - Участник, который был побежден.
     * @param {number} takenPercentage - Процент забираемых очков силы.
     */
    public shareSpoils(defeated: FfaParticipant, takenPercentage: number): void {
        const distributedPower = defeated.powerPoints * takenPercentage;
        log.info(`[Команда ${this.id}] Распределение трофеев за победу над ${defeated.name}. Всего очков для распределения: ${Math.round(distributedPower)}.`);
        defeated.powerPoints -= distributedPower;

        const members = this.getMembers();
        const totalDamage = members.reduce((sum, member) => sum + Math.max(1, member.damageDealtTo.get(defeated.id) || 0), 0);
        log.info(`[Команда ${this.id}] Общий урон по ${defeated.name} от команды: ${Math.round(totalDamage)}.`);

        for (const member of members) {
            const damageShare = Math.max(1, member.damageDealtTo.get(defeated.id) || 0) / totalDamage;
            const gain = distributedPower * damageShare;
            member.powerPoints += gain;
            log.info(`[Команда ${this.id}] -> ${member.name} получает ${Math.round(gain)} очков (доля урона: ${Math.round(damageShare * 100)}%).`);

            const msg = createGameMessageWithSound(`За победу над ${defeated.name} вам начислено ${Math.round(gain)} очков силы (ваша доля составляет ${Math.round(damageShare * 100)} %).`, member.settlement.SettlementColor);
            member.settlement.Messages.AddMessage(msg);
            // Сбрасываем счетчики урона после распределения трофеев
            member.damageDealtTo.set(defeated.id, 0);
            member.castleDamageDealtTo.set(defeated.id, 0);
        }
    }

    /**
     * Устанавливает мирный договор (нейтральную дипломатию) со всеми другими командами.
     * @param {Team[]} allTeams - Список всех команд в игре.
     */
    public setPeaceStatusWithAll(allTeams: Team[]): void {
        log.info(`[Команда ${this.id}] Устанавливает мир со всеми командами.`);
        this.setDiplomacyWithAll(allTeams, DiplomacyStatus.Neutral);
    }

    /**
     * Объявляет войну всем другим командам.
     * @param {Team[]} allTeams - Список всех команд в игре.
     */
    public setWarStatusWithAll(allTeams: Team[]): void {
        log.info(`[Команда ${this.id}] Объявляет войну всем командам.`);
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
        log.info(`[Команда ${this.id}] Внутренняя процедура смены сюзерена с ${oldSuzerain.name} на ${newSuzerain.name}.`);

        // Новый сюзерен больше не является вассалом
        this._vassals.delete(newSuzerain.id);
        newSuzerain.suzerain = null;

        // Старый сюзерен становится вассалом
        this._vassals.set(oldSuzerain.id, oldSuzerain);

        // Обновляем ссылку на сюзерена команды
        this._suzerain = newSuzerain;

        // Обновляем сюзерена и цель для всех вассалов (включая бывшего сюзерена)
        for (const vassal of this.vassals) {
            vassal.suzerain = newSuzerain;
            vassal.target = newSuzerain.target;
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
            log.info(`[Команда ${this.id}] Установка статуса '${DiplomacyStatus[status]}' с командой ${otherTeam.id}.`);

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
        log.info(`[Команда ${this.id}] Обновление дипломатии для нового члена ${newMember.name}. Установка союза с членами команды.`);
        for (const member of this.getMembers()) {
            if (newMember.id !== member.id) {
                DiplomacyManager.setDiplomacy(newMember, member, DiplomacyStatus.Alliance);
            }
        }
    }
}