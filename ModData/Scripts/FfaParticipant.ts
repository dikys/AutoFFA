import { Settlement, Unit, UnitConfig, UnitDirection, UnitCommand } from "library/game-logic/horde-types";
import { createResourcesAmount, ResourcesAmount, Point2D, createPoint } from "library/common/primitives";
import { createGameMessageWithSound } from "library/common/messages";
import { generateCellInSpiral } from "library/common/position-tools";
import { unitCanBePlacedByRealMap } from "library/game-logic/unit-and-map";
import { AutoFFASettings } from "./AutoFFASettings";
import { log } from "library/common/logging";

const SpawnUnitParameters = HordeClassLibrary.World.Objects.Units.SpawnUnitParameters;

/**
 * Представляет участника в игровом режиме "Каждый за себя" (Free-For-All).
 * Управляет состоянием и действиями поселения одного игрока.
 */
export class FfaParticipant {
    // ==================================================================================================
    // Public properties
    // ==================================================================================================

    public readonly id: number;
    public readonly settlement: Settlement;
    public readonly name: string;
    public readonly castleConfig: UnitConfig;
    public readonly initialCastlePosition: Point2D;

    public teamId: number;
    public suzerain: FfaParticipant | null = null;
    public target: FfaParticipant | null = null;
    public isDefeated: boolean = false;
    public powerPoints: number = 0; // Начальное значение устанавливается из настроек
    public damageDealtTo: Map<number, number> = new Map();
    public castleDamageDealtTo: Map<number, number> = new Map();
    public lastPowerPointGainTick: number = 0;
    public currentBattlePowerPoints: number = 0;
    public nextRewardTime: number;
    public totalPointsFromTribute: number = 0;
    public totalPointsFromGenerosity: number = 0;

    // ==================================================================================================
    // Private properties
    // ==================================================================================================

    // @ts-ignore
    private _castle: Unit;
    private readonly settings: AutoFFASettings;

    // ==================================================================================================
    // Constructor
    // ==================================================================================================

    constructor(id: number, settlement: Settlement, name: string, initialCastle: Unit, settings: AutoFFASettings) {
        this.id = id;
        this.settlement = settlement;
        this.name = name;
        this.teamId = id; // Изначально каждый участник находится в своей собственной команде
        this.castle = initialCastle; // Используем сеттер для применения специальной логики
        this.castleConfig = initialCastle.Cfg;
        this.initialCastlePosition = initialCastle.Cell;
        this.settings = settings;

        const settlementCensusModel = ScriptUtils.GetValue(this.settlement.Census, "Model");
        this.nextRewardTime = settlementCensusModel.TaxAndSalaryUpdatePeriod;

        log.info(`[${this.name}] Участник создан. Начальная позиция замка: ${this.initialCastlePosition.X},${this.initialCastlePosition.Y}.`);
    }

    // ==================================================================================================
    // Public getters and setters
    // ==================================================================================================

    public get castle(): Unit {
        return this._castle;
    }

    public set castle(newCastle: Unit) {
        this._castle = newCastle;
        // Запрещаем уничтожение замка его владельцем
        const commandsMind = this._castle.CommandsMind;
        const disallowedCommands = ScriptUtils.GetValue(commandsMind, "DisallowedCommands");
        if (!disallowedCommands.ContainsKey(UnitCommand.DestroySelf)) {
            log.info(`[${this.name}] Установлен новый замок (ID: ${newCastle.Id}). Самоуничтожение запрещено.`);
            disallowedCommands.Add(UnitCommand.DestroySelf, 1);
        }
    }

    /**
     * Проверяет, является ли участник сюзереном (не имеет сюзерена).
     * @returns {boolean} True, если участник является сюзереном.
     */
    public isSuzerain(): boolean {
        return this.suzerain === null;
    }

    /**
     * Проверяет, является ли участник вассалом (имеет сюзерена).
     * @returns {boolean} True, если участник является вассалом.
     */
    public isVassal(): boolean {
        return this.suzerain !== null;
    }

    // ==================================================================================================
    // Public methods
    // ==================================================================================================

    /**
     * Платит дань сюзерену, если превышены лимиты ресурсов и населения.
     * @returns {boolean} True, если дань была уплачена.
     */
    public payTribute(): boolean {
        if (!this.isVassal() || !this.suzerain) {
            return false;
        }
        log.info(`[${this.name}] Проверка уплаты дани сюзерену ${this.suzerain.name}.`);

        const resourceLimit = Math.floor(this.settings.vassalResourceLimit + 0.1 * this.powerPoints);
        const populationLimit = Math.floor(this.settings.vassalPopulationLimit + 0.002 * this.powerPoints);
        log.info(`[${this.name}] Лимиты: Ресурсы=${resourceLimit}, Население=${populationLimit}. Текущие ресурсы: G:${this.settlement.Resources.Gold}, M:${this.settlement.Resources.Metal}, L:${this.settlement.Resources.Lumber}. Своб. население: ${this.settlement.Resources.FreePeople}.`);

        const tribute = createResourcesAmount(
            Math.max(0, this.settlement.Resources.Gold - resourceLimit),
            Math.max(0, this.settlement.Resources.Metal - resourceLimit),
            Math.max(0, this.settlement.Resources.Lumber - resourceLimit),
            Math.max(0, this.settlement.Resources.FreePeople - populationLimit)
        );

        if (tribute.Gold > 0 || tribute.Metal > 0 || tribute.Lumber > 0 || tribute.People > 0) {
            log.info(`[${this.name}] Рассчитана дань: ${tribute.Gold}G, ${tribute.Metal}M, ${tribute.Lumber}L, ${tribute.People}P.`);
            this.settlement.Resources.TakeResources(tribute);
            
            const resourceTribute = createResourcesAmount(tribute.Gold, tribute.Metal, tribute.Lumber, 0);
            if (resourceTribute.Gold > 0 || resourceTribute.Metal > 0 || resourceTribute.Lumber > 0) {
                log.info(`[${this.name}] -> Передача ресурсов сюзерену ${this.suzerain.name}.`);
                this.suzerain.receiveResources(resourceTribute);
                
                // Возвращаем обмен очками с надежной защитой от зацикливания
                if (this.settings.enablePowerPointsExchange) {
                    const totalResourceValue = resourceTribute.Gold + resourceTribute.Metal + resourceTribute.Lumber;
                    if (totalResourceValue > 0) {
                        const pointsToTransfer = totalResourceValue * this.settings.powerPointsExchangeRate;
                        
                        // НАДЕЖНАЯ ЗАЩИТА: Сюзерен передает очки, только если он останется сильнее вассала ПОСЛЕ обмена.
                        const powerDifference = this.suzerain.powerPoints - this.powerPoints;

                        // Чтобы сюзерен остался сильнее, разница в силе должна быть больше, чем удвоенное 
                        // количество передаваемых очков. Это гарантирует, что смена власти не произойдет.
                        if (powerDifference > pointsToTransfer * 2) {
                            const actualPointsTransferred = Math.min(this.suzerain.powerPoints, pointsToTransfer);

                            if (actualPointsTransferred > 0) {
                                log.info(`[${this.name}] Обмен очками за дань: ${this.suzerain.name} (-${Math.round(actualPointsTransferred)}) -> ${this.name} (+${Math.round(actualPointsTransferred)}).`);
                                this.suzerain.powerPoints -= actualPointsTransferred;
                                this.powerPoints += actualPointsTransferred;

                                // Отслеживаем обмен для итоговой сводки
                                this.suzerain.totalPointsFromTribute -= actualPointsTransferred;
                                this.totalPointsFromTribute += actualPointsTransferred;
                            }
                        } else {
                            log.info(`[${this.name}] Обмен очками за дань не произошел: передача (${Math.round(pointsToTransfer)}) нарушила бы баланс сил. Разница: ${Math.round(powerDifference)}.`);
                        }
                    }
                }
            }
            return true;
        }
        log.info(`[${this.name}] Дань не требуется.`);
        return false;
    }

    /**
     * Добавляет ресурсы в поселение этого участника.
     * @param {ResourcesAmount} amount - Количество добавляемых ресурсов.
     */
    public receiveResources(amount: ResourcesAmount): void {
        log.info(`[${this.name}] Получение ресурсов: ${amount.Gold}G, ${amount.Metal}M, ${amount.Lumber}L, ${amount.People}P.`);
        this.settlement.Resources.AddResources(amount);
    }

    /**
     * Сбрасывает счетчики урона для этого участника.
     */
    public resetDamageCounters(): void {
        log.info(`[${this.name}] Сброс счетчиков урона.`);
        this.damageDealtTo.clear();
        this.castleDamageDealtTo.clear();
    }

    /**
     * Возрождает замок участника в допустимом месте рядом с его начальной позицией.
     */
    public respawnCastle(): void {
        log.info(`[${this.name}] Попытка возродить замок...`);
        const generator = generateCellInSpiral(this.initialCastlePosition.X, this.initialCastlePosition.Y);
        const spawnParams = new SpawnUnitParameters();
        spawnParams.ProductUnitConfig = this.castleConfig;
        spawnParams.Direction = UnitDirection.RightDown;

        for (let pos = generator.next(); !pos.done; pos = generator.next()) {
            if (unitCanBePlacedByRealMap(this.castleConfig, pos.value.X, pos.value.Y)) {
                spawnParams.Cell = createPoint(pos.value.X, pos.value.Y);
                const newCastle = this.settlement.Units.SpawnUnit(spawnParams);

                if (newCastle) {
                    log.info(`[${this.name}] Замок успешно возрожден в ${pos.value.X},${pos.value.Y}.`);
                    this.castle = newCastle; // Используем сеттер для применения логики
                    return;
                }
            }
        }
        log.error(`[${this.name}] НЕ УДАЛОСЬ возродить замок! Не найдено свободного места.`);
    }

    /**
     * Выдает участнику награду в виде ресурсов на основе его очков силы.
     * @returns {boolean} True, если награда была выдана.
     */
    public givePowerPointReward(): boolean {
        log.info(`[${this.name}] Проверка наград за очки силы. Текущие очки: ${Math.round(this.powerPoints)}`);
        if (this.settings.enablePowerPointsExchange) {
            // Сообщение об обмене очками
            let exchangeSummary = "";
            if (Math.abs(this.totalPointsFromTribute) >= 1) {
                const action = this.totalPointsFromTribute > 0 ? "Получено" : "Потрачено";
                const points = Math.round(Math.abs(this.totalPointsFromTribute));
                exchangeSummary += `${action} ${points} очков в качестве платы за верность. `;
            }
            if (Math.abs(this.totalPointsFromGenerosity) >= 1) {
                const action = this.totalPointsFromGenerosity > 0 ? "Получено" : "Потрачено";
                const points = Math.round(Math.abs(this.totalPointsFromGenerosity));
                exchangeSummary += `${action} ${points} очков в благодарность за щедрость.`;
            }

            if (exchangeSummary) {
                log.info(`[${this.name}] Сводка по обмену очками: ${exchangeSummary.trim()}`);
                const msg = createGameMessageWithSound(exchangeSummary.trim(), this.settlement.SettlementColor);
                this.settlement.Messages.AddMessage(msg);
            }

            this.totalPointsFromTribute = 0;
            this.totalPointsFromGenerosity = 0;
        }

        const settlementCensusModel = ScriptUtils.GetValue(this.settlement.Census, "Model");
        this.nextRewardTime += settlementCensusModel.TaxAndSalaryUpdatePeriod;
        log.info(`[${this.name}] Следующее время награды обновлено на ${this.nextRewardTime}.`);

        if (this.powerPoints < 10) {
            log.info(`[${this.name}] Недостаточно очков силы (${Math.round(this.powerPoints)}) для награды. Пропускаем.`);
            return false;
        }

        const rewardPercentage = this.settings.powerPointsRewardPercentage;
        const peopleMultiplier = 0.02;

        const resourceReward = Math.floor(rewardPercentage * this.powerPoints);
        const peopleReward = Math.floor(peopleMultiplier * rewardPercentage * this.powerPoints);

        log.info(`[${this.name}] Расчет награды. Очки: ${Math.round(this.powerPoints)}, %: ${rewardPercentage}. Ресурсы: ${resourceReward}, Люди: ${peopleReward}`);
        
        const reward = createResourcesAmount(
            resourceReward,
            resourceReward,
            resourceReward,
            peopleReward
        );
        this.settlement.Resources.AddResources(reward);
        log.info(`[${this.name}] Награда выдана.`);
        return true;
    }

    /**
     * Рассчитывает текущую общую мощь участника.
     * Мощь - это сумма ресурсов и стоимости всех юнитов.
     * @returns {number} Общее значение мощи.
     */
    public getCurrentPower(): number {
        let power = this.settlement.Resources.Gold + this.settlement.Resources.Metal + this.settlement.Resources.Lumber + 50 * this.settlement.Resources.FreePeople;

        // Этот паттерн перечисления является стандартным для API игры.
        let enumerator = this.settlement.Units.GetEnumerator();
        while(enumerator.Current && enumerator.MoveNext()) {
            const unitCost = enumerator.Current.Cfg.CostResources;
            power += unitCost.Gold + unitCost.Metal + unitCost.Lumber + (50 * unitCost.People);
        }
        enumerator.Dispose();
        
        return power;
    }
}
