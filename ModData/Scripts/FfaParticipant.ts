import { Settlement, Unit, UnitConfig, UnitDirection, UnitCommand } from "library/game-logic/horde-types";
import { createResourcesAmount, ResourcesAmount, Point2D, createPoint } from "library/common/primitives";
import { generateCellInSpiral } from "library/common/position-tools";
import { unitCanBePlacedByRealMap } from "library/game-logic/unit-and-map";
import { AutoFFASettings } from "./AutoFFASettings";

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
     */
    public payTribute(): void {
        if (!this.isVassal() || !this.suzerain) {
            return;
        }

        const resourceLimit = Math.floor(this.settings.vassalResourceLimit + 0.1 * this.powerPoints);
        const populationLimit = Math.floor(this.settings.vassalPopulationLimit + 0.002 * this.powerPoints);

        const tribute = createResourcesAmount(
            Math.max(0, this.settlement.Resources.Gold - resourceLimit),
            Math.max(0, this.settlement.Resources.Metal - resourceLimit),
            Math.max(0, this.settlement.Resources.Lumber - resourceLimit),
            Math.max(0, this.settlement.Resources.FreePeople - populationLimit)
        );

        if (tribute.Gold > 0 || tribute.Metal > 0 || tribute.Lumber > 0 || tribute.People > 0) {
            this.settlement.Resources.TakeResources(tribute);
            
            const resourceTribute = createResourcesAmount(tribute.Gold, tribute.Metal, tribute.Lumber, 0);
            if (resourceTribute.Gold > 0 || resourceTribute.Metal > 0 || resourceTribute.Lumber > 0) {
                this.suzerain.receiveResources(resourceTribute);
            }
        }
    }

    /**
     * Добавляет ресурсы в поселение этого участника.
     * @param {ResourcesAmount} amount - Количество добавляемых ресурсов.
     */
    public receiveResources(amount: ResourcesAmount): void {
        this.settlement.Resources.AddResources(amount);
    }

    /**
     * Сбрасывает счетчики урона для этого участника.
     */
    public resetDamageCounters(): void {
        this.damageDealtTo.clear();
        this.castleDamageDealtTo.clear();
    }

    /**
     * Возрождает замок участника в допустимом месте рядом с его начальной позицией.
     */
    public respawnCastle(): void {
        const generator = generateCellInSpiral(this.initialCastlePosition.X, this.initialCastlePosition.Y);
        const spawnParams = new SpawnUnitParameters();
        spawnParams.ProductUnitConfig = this.castleConfig;
        spawnParams.Direction = UnitDirection.RightDown;

        for (let pos = generator.next(); !pos.done; pos = generator.next()) {
            if (unitCanBePlacedByRealMap(this.castleConfig, pos.value.X, pos.value.Y)) {
                spawnParams.Cell = createPoint(pos.value.X, pos.value.Y);
                const newCastle = this.settlement.Units.SpawnUnit(spawnParams);

                if (newCastle) {
                    this.castle = newCastle; // Используем сеттер для применения логики
                    return;
                }
            }
        }
    }

    /**
     * Выдает участнику награду в виде ресурсов на основе его очков силы.
     */
    public givePowerPointReward(): void {
        if (this.powerPoints < 10) return;

        const reward = createResourcesAmount(
            Math.floor(this.settings.powerPointsRewardPercentage * this.powerPoints),
            Math.floor(this.settings.powerPointsRewardPercentage * this.powerPoints),
            Math.floor(this.settings.powerPointsRewardPercentage * this.powerPoints),
            Math.floor(0.02 * this.settings.powerPointsRewardPercentage * this.powerPoints)
        );
        this.settlement.Resources.AddResources(reward);

        const settlementCensusModel = ScriptUtils.GetValue(this.settlement.Census, "Model");
        this.nextRewardTime += settlementCensusModel.TaxAndSalaryUpdatePeriod;
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
