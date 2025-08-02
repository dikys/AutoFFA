import { Settlement, Unit, UnitConfig, UnitDirection, UnitCommand } from "library/game-logic/horde-types";
import { createResourcesAmount, ResourcesAmount, Point2D, createPoint } from "library/common/primitives";
import { generateCellInSpiral } from "library/common/position-tools";
import { unitCanBePlacedByRealMap } from "library/game-logic/unit-and-map";
import { createGameMessageWithSound } from "library/common/messages";

const SpawnUnitParameters = HordeClassLibrary.World.Objects.Units.SpawnUnitParameters;

/**
 * Представляет участника FFA (поселение).
 * Хранит состояние и управляет действиями отдельного игрока.
 */
export class FfaParticipant {
    // Настройки, вынесенные в статические константы
    public static readonly VASSAL_RESOURCE_LIMIT = 1000;
    public static readonly VASSAL_POPULATION_LIMIT = 60;
    public static readonly POWER_POINTS_REWARD_PERCENTAGE = 0.10;

    public readonly id: number;
    public readonly settlement: Settlement;
    public readonly name: string;
    
    public teamId: number;
    public suzerain: FfaParticipant | null = null;

    public isDefeated: boolean = false;
    public powerPoints: number = 1500;
    
    public readonly castleConfig: UnitConfig;
    public readonly initialCastlePosition: Point2D;
    // @ts-ignore
    private _castle: Unit;

    public damageDealtTo: Map<number, number> = new Map();

    public nextRewardTime: number;

    constructor(id: number, settlement: Settlement, name: string, initialCastle: Unit) {
        this.id = id;
        this.settlement = settlement;
        this.name = name;
        this.teamId = id; // Изначально каждый в своей команде
        this.castle = initialCastle; // Используем сеттер
        this.castleConfig = initialCastle.Cfg;
        this.initialCastlePosition = initialCastle.Cell;

        const settlementCensusModel = ScriptUtils.GetValue(this.settlement.Census, "Model");
        this.nextRewardTime = settlementCensusModel.TaxAndSalaryUpdatePeriod;
    }

    public get castle(): Unit {
        return this._castle;
    }

    public set castle(newCastle: Unit) {
        this._castle = newCastle;
        // Запрещаем самоуничтожение замка
        const commandsMind = this._castle.CommandsMind;
        const disallowedCommands = ScriptUtils.GetValue(commandsMind, "DisallowedCommands");
        if (!disallowedCommands.ContainsKey(UnitCommand.DestroySelf)) {
            disallowedCommands.Add(UnitCommand.DestroySelf, 1);
        }
    }

    public isSuzerain(): boolean {
        return this.suzerain === null;
    }

    public isVassal(): boolean {
        return this.suzerain !== null;
    }

    public payTribute(): void {
        if (!this.isVassal() || !this.suzerain) {
            return;
        }

        const resourceLimit = Math.floor(FfaParticipant.VASSAL_RESOURCE_LIMIT + 0.1 * this.powerPoints);
        const populationLimit = Math.floor(FfaParticipant.VASSAL_POPULATION_LIMIT + 0.002 * this.powerPoints);

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

    public receiveResources(amount: ResourcesAmount): void {
        this.settlement.Resources.AddResources(amount);
    }

    public respawnCastle(): void {
        // Используем начальную позицию замка как центр для поиска места возрождения
        const spawnPosition = this.initialCastlePosition;

        const generator = generateCellInSpiral(spawnPosition.X, spawnPosition.Y);
        const spawnParams = new SpawnUnitParameters();
        spawnParams.ProductUnitConfig = this.castleConfig;
        spawnParams.Direction = UnitDirection.RightDown;

        for (let pos = generator.next(); !pos.done; pos = generator.next()) {
            if (unitCanBePlacedByRealMap(this.castleConfig, pos.value.X, pos.value.Y)) {
                spawnParams.Cell = createPoint(pos.value.X, pos.value.Y);
                const newCastle = this.settlement.Units.SpawnUnit(spawnParams);

                if (newCastle) {
                    this.castle = newCastle;
                    return;
                }
            }
        }
    }

    public givePowerPointReward(): void {
        if (this.powerPoints < 10) return;

        const reward = createResourcesAmount(
            Math.floor(FfaParticipant.POWER_POINTS_REWARD_PERCENTAGE * this.powerPoints),
            Math.floor(FfaParticipant.POWER_POINTS_REWARD_PERCENTAGE * this.powerPoints),
            Math.floor(FfaParticipant.POWER_POINTS_REWARD_PERCENTAGE * this.powerPoints),
            Math.floor(0.02 * FfaParticipant.POWER_POINTS_REWARD_PERCENTAGE * this.powerPoints)
        );
        this.settlement.Resources.AddResources(reward);

        const settlementCensusModel = ScriptUtils.GetValue(this.settlement.Census, "Model");
        this.nextRewardTime += settlementCensusModel.TaxAndSalaryUpdatePeriod;
    }

    public getCurrentPower(): number {
        let power = this.settlement.Resources.Gold + this.settlement.Resources.Metal + this.settlement.Resources.Lumber + 50 * this.settlement.Resources.FreePeople;

        let enumerator = this.settlement.Units.GetEnumerator();
        while(enumerator.Current && enumerator.MoveNext()) {
            power += enumerator.Current.Cfg.CostResources.Gold + enumerator.Current.Cfg.CostResources.Metal + enumerator.Current.Cfg.CostResources.Lumber + 50*enumerator.Current.Cfg.CostResources.People;
        }
        enumerator.Dispose();
        
        return power;
    }
}