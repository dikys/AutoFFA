import { AutoFFASettings } from "./AutoFFASettings";
import HordePluginBase from "plugins/base-plugin";
import { log, LogLevel } from "library/common/logging";
import { broadcastMessage, createGameMessageWithSound } from "library/common/messages";
import { createHordeColor, createPoint } from "library/common/primitives";
import { BattleController, DiplomacyStatus, DrawLayer, FontUtils, GeometryCanvas, GeometryVisualEffect, Stride_Color, Stride_Vector2, StringVisualEffect } from "library/game-logic/horde-types";
import { isReplayMode } from "library/game-logic/game-tools";
import { spawnGeometry, spawnString } from "library/game-logic/decoration-spawn";
import { FfaParticipant } from "./FfaParticipant";
import { DiplomacyManager } from "./DiplomacyManager";
import { Team } from "./Team";

/**
 * Рассчитывает расстояние Чебышева между двумя точками.
 */
function chebyshevDistance(x1: number, y1: number, x2: number, y2: number): number {
    return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

/**
 * Основной класс плагина для игрового режима Auto FFA.
 */
export class AutoFfaPlugin extends HordePluginBase {
    // ==================================================================================================
    // Константы
    // ==================================================================================================

    private readonly GAME_CYCLE_PERIOD = 100;
    private readonly TICK_OFFSET = {
        TRIBUTES: 11,
        GENEROSITY: 22,
        MIGRATIONS: 33,
        PEACE_TREATY_CHECK: 44,
        DECORATORS: 55,
        PROMOTIONS: 66,
        REWARDS: 77,
        DEFEATS: 88,
        BOUNTY_CHECK: 95,
        TARGET_CHECK: 96,
        BATTLE_SUMMARY_CHECK: 98,
        GAME_END_CHECK: 99,
        COALITION_CHECK: 97,
    };

    // ==================================================================================================
    // Приватные свойства
    // ==================================================================================================

    private participants: Map<number, FfaParticipant> = new Map();
    private teams: Map<number, Team> = new Map();
    private settlementUidToParticipantId: Map<string, number> = new Map();
    private unitCfgUidToPowerPerHp: Map<string, number> = new Map();

    private powerPointDecorators: Map<number, StringVisualEffect> = new Map();
    private statusDecorators: Map<number, StringVisualEffect> = new Map();
    private targetDecorators: Map<number, StringVisualEffect> = new Map();
    private castleFrames: Map<number, GeometryVisualEffect> = new Map();

    private isGameFinished = false;
    private readonly settings: AutoFFASettings;
    private bountyParticipant: FfaParticipant | null = null;
    private mapLinearSize: number = 1;
    private nextBountyCheckTick = 0;
    private initialPeaceEndTick = 0; // Тик, когда закончится начальный мир

    // ==================================================================================================
    // Конструктор
    // ==================================================================================================

    constructor(settings: AutoFFASettings) {
        super("Auto FFA (OOP)");
        this.settings = settings;
        this.log.logLevel = LogLevel.Info;
    }

    // ==================================================================================================
    // Переопределения HordePluginBase
    // ==================================================================================================

    public onFirstRun(): void {
        broadcastMessage("Добро пожаловать в Auto FFA!\nКаждый сам за себя! Уничтожьте вражеский замок, чтобы сделать его своим вассалом.", createHordeColor(255, 255, 140, 140));
    }

    public onEveryTick(gameTickNum: number): void {
        if (this.isGameFinished) return;

        if (gameTickNum === 1) {
            this.initialize();
            return;
        }

        // Проверяем окончание начального мирного периода
        if (this.initialPeaceEndTick > 0 && gameTickNum >= this.initialPeaceEndTick) {
            this.endInitialPeace();
            this.initialPeaceEndTick = 0; // Сбрасываем, чтобы не вызывать снова
        }

        this.displayInitialMessages(gameTickNum);
        if (gameTickNum < 50 * 100) return; // Ждем отображения начальных сообщений

        switch (gameTickNum % this.GAME_CYCLE_PERIOD) {
            case this.TICK_OFFSET.TRIBUTES: this.processVassalTributes(); break;
            case this.TICK_OFFSET.GENEROSITY: this.processSuzerainGenerosity(); break;
            case this.TICK_OFFSET.MIGRATIONS: this.processTeamMigrations(gameTickNum); break;
            case this.TICK_OFFSET.PEACE_TREATY_CHECK: this.managePeaceTreaties(gameTickNum); break;
            case this.TICK_OFFSET.DECORATORS: this.updateDecorators(); break;
            case this.TICK_OFFSET.PROMOTIONS: this.promoteNewSuzerains(); break;
            case this.TICK_OFFSET.REWARDS: this.processPowerPointRewards(gameTickNum); break;
            case this.TICK_OFFSET.DEFEATS: this.checkForDefeatedParticipants(); break;
            case this.TICK_OFFSET.TARGET_CHECK: this.checkAndReassignTargets(); break;
            case this.TICK_OFFSET.BOUNTY_CHECK: this.checkForBounty(gameTickNum); break;
            case this.TICK_OFFSET.BATTLE_SUMMARY_CHECK: this.checkBattleSummaries(gameTickNum); break;
            case this.TICK_OFFSET.GAME_END_CHECK: this.checkForGameEnd(); break;
            case this.TICK_OFFSET.COALITION_CHECK: this.manageCoalitions(); break;
        }
    }

    // ==================================================================================================
    // Инициализация
    // ==================================================================================================

    private initialize(): void {
        this.log.info("Инициализация Auto FFA...");

        var scenaWidth  = ActiveScena.GetRealScena().Size.Width;
        var scenaHeight = ActiveScena.GetRealScena().Size.Height;
        this.mapLinearSize = Math.sqrt(2)*Math.sqrt(scenaWidth * scenaHeight);
        if (this.mapLinearSize <= 1) {
            this.log.warning(`Не удалось определить размер карты (${this.mapLinearSize}), множитель за расстояние может работать некорректно. Установлено значение по умолчанию 256.`);
            this.mapLinearSize = 100; // Fallback
        }

        this.setupParticipantsAndTeams();
        this.setInitialDiplomacy();
        this.checkAndReassignTargets(); // Назначим начальные цели
        this.subscribeToEvents();
        this.updateDecorators();

        if (this.settings.enableInitialPeacePeriod) {
            this.initialPeaceEndTick = this.settings.initialPeaceDurationTicks;
        }

        if (this.settings.enableBountyOnLeader) {
            this.nextBountyCheckTick = this.initialPeaceEndTick + this.settings.bountyCheckIntervalTicks;
        }

        this.log.info(`Инициализация завершена. Найдено ${this.participants.size} участников.`);
    }

    private setupParticipantsAndTeams(): void {
        const sceneSettlements = ActiveScena.GetRealScena().Settlements;
        const settlementUidToPlayerNames = new Map<string, string[]>();

        // Собираем имена всех игроков для каждого поселения
        for (const player of Players) {
            const realPlayer = player.GetRealPlayer();
            if (isReplayMode() && !realPlayer.IsReplay) continue;
            
            const settlementUid = realPlayer.GetRealSettlement().Uid;
            const nickname = realPlayer.Nickname;

            if (!settlementUidToPlayerNames.has(settlementUid)) {
                settlementUidToPlayerNames.set(settlementUid, []);
            }
            settlementUidToPlayerNames.get(settlementUid)!.push(nickname);
        }

        let participantIdCounter = 0;
        for (const uid of Array.from(settlementUidToPlayerNames.keys()).sort()) {
            const settlement = sceneSettlements.Item.get(uid);
            const castle = settlement.Units.GetCastleOrAnyUnit();

            if (!castle || !castle.Cfg.HasMainBuildingSpecification) {
                this.log.warning(`Поселение ${uid} не имеет замка и будет проигнорировано.`);
                continue;
            }

            // Объединяем имена игроков, если их несколько, или используем имя лидера по умолчанию
            const playerNames = settlementUidToPlayerNames.get(uid);
            const name = (playerNames && playerNames.length > 0) ? playerNames.join(' & ') : settlement.LeaderName;
            const participant = new FfaParticipant(participantIdCounter, settlement, name, castle, this.settings);
            participant.powerPoints = this.settings.initialPowerPoints;
            
            this.participants.set(participant.id, participant);
            this.settlementUidToParticipantId.set(uid, participant.id);
            
            const team = new Team(participant.id, participant, this.settings);
            this.teams.set(team.id, team);

            this.createDecoratorsForParticipant(participant);
            this.setCustomGameRules(settlement);

            participantIdCounter++;
        }
    }

    private setCustomGameRules(settlement: any): void {
        const existenceRule = settlement.RulesOverseer.GetExistenceRule();
        const principalInstruction = ScriptUtils.GetValue(existenceRule, "PrincipalInstruction");
        ScriptUtils.SetValue(principalInstruction, "AlmostDefeatCondition", HordeClassLibrary.World.Settlements.Existence.AlmostDefeatCondition.Custom);
        ScriptUtils.SetValue(principalInstruction, "TotalDefeatCondition", HordeClassLibrary.World.Settlements.Existence.TotalDefeatCondition.Custom);
        ScriptUtils.SetValue(principalInstruction, "VictoryCondition", HordeClassLibrary.World.Settlements.Existence.VictoryCondition.Custom);
    }

    private setInitialDiplomacy(): void {
        const allParticipants = Array.from(this.participants.values());
        if (this.settings.enableInitialPeacePeriod) {
            DiplomacyManager.establishPeaceAmongAll(allParticipants);
        } else {
            for (let i = 0; i < allParticipants.length; i++) {
                for (let j = i + 1; j < allParticipants.length; j++) {
                    DiplomacyManager.setDiplomacy(allParticipants[i], allParticipants[j], DiplomacyStatus.War);
                }
            }
        }
    }

    private endInitialPeace(): void {
        const allParticipants = Array.from(this.participants.values());
        for (let i = 0; i < allParticipants.length; i++) {
            for (let j = i + 1; j < allParticipants.length; j++) { 
                if (allParticipants[i].teamId !== allParticipants[j].teamId) {
                    DiplomacyManager.setDiplomacy(allParticipants[i], allParticipants[j], DiplomacyStatus.War);
                }
            }
        }
        const message = "Время подготовки истекло! Война начинается!";
        broadcastMessage(message, createHordeColor(255, 255, 255, 0)); // Желтый цвет
        this.log.info(message);
    }

    private subscribeToEvents(): void {
        for (const participant of Array.from(this.participants.values())) {
            participant.settlement.Units.UnitCauseDamage.connect(this.onUnitCauseDamage.bind(this));
        }
    }

    // ... (остальной код без изменений)
    private onUnitCauseDamage(sender: any, args: any): void {
        const attackerOwnerUid = args.TriggeredUnit.Owner.Uid;
        const victimOwnerUid = args.VictimUnit.Owner.Uid;

        const attackerId = this.settlementUidToParticipantId.get(attackerOwnerUid);
        const victimId = this.settlementUidToParticipantId.get(victimOwnerUid);

        if (attackerId === undefined || victimId === undefined || attackerId === victimId) return;

        const attacker = this.participants.get(attackerId);
        const victim = this.participants.get(victimId);
        if (!attacker || !victim) return;

        const diplomacy = DiplomacyManager.getDiplomacyStatus(attacker, victim);

        if (diplomacy === DiplomacyStatus.War) {
            this.increaseAttackerPower(attacker, victim, args);
        } else if (diplomacy === DiplomacyStatus.Neutral) {
            if (args.VictimUnit.Health < args.VictimUnit.Cfg.MaxHealth) {
                 args.VictimUnit.Health += Math.min(args.VictimUnit.Cfg.MaxHealth - args.VictimUnit.Health, args.Damage);
            }
        }
    }

    private increaseAttackerPower(attacker: FfaParticipant, victim: FfaParticipant, damageArgs: any): void {
        let powerPointPerHp = this.unitCfgUidToPowerPerHp.get(damageArgs.VictimUnit.Cfg.Uid);
        if (powerPointPerHp === undefined) {
            const cfg = damageArgs.VictimUnit.Cfg;
            powerPointPerHp = this.settings.powerPointPerHpCoeff * (cfg.CostResources.Gold + cfg.CostResources.Metal + cfg.CostResources.Lumber + 50 * cfg.CostResources.People) / cfg.MaxHealth;
            this.unitCfgUidToPowerPerHp.set(cfg.Uid, powerPointPerHp);
        }

        const distance = chebyshevDistance(
            attacker.castle.Cell.X, attacker.castle.Cell.Y,
            damageArgs.TriggeredUnit.Cell.X, damageArgs.TriggeredUnit.Cell.Y
        );

        // Множитель за расстояние, линейно от 1 (вблизи замка) до 2 (на краю карты).
        const distanceFactor = Math.min(
            1 + (this.settings.powerPointCoeffByMaxDistance - 1) * (distance / this.mapLinearSize),
            this.settings.powerPointCoeffByMaxDistance);
        
        let deltaPoints = damageArgs.Damage * powerPointPerHp * distanceFactor;

        if (this.bountyParticipant && victim.id === this.bountyParticipant.id) {
            deltaPoints *= this.settings.bountyPowerPointsMultiplier;
        }

        if (this.settings.enableTargetSystem && attacker.target && victim.id === attacker.target.id) {
            deltaPoints *= this.settings.targetPowerPointsMultiplier;
        }

        if (deltaPoints > 0) {
            attacker.powerPoints += deltaPoints;
            attacker.damageDealtTo.set(victim.id, (attacker.damageDealtTo.get(victim.id) || 0) + deltaPoints);

            if (this.settings.enableBattleSummaryMessages) {
                attacker.currentBattlePowerPoints += deltaPoints;
                attacker.lastPowerPointGainTick = BattleController.GameTimer.GameFramesCounter;
            }
        }
    }

    private checkForBounty(gameTickNum: number): void {
        if (!this.settings.enableBountyOnLeader || gameTickNum < this.nextBountyCheckTick) {
            return;
        }

        this.nextBountyCheckTick = gameTickNum + this.settings.bountyCheckIntervalTicks;

        let richestParticipant: FfaParticipant | null = null;
        let maxPower = -1;

        // Ищем самого богатого игрока среди всех активных участников
        for (const participant of Array.from(this.participants.values())) {
            if (!participant.isDefeated && participant.powerPoints > maxPower) {
                maxPower = participant.powerPoints;
                richestParticipant = participant;
            }
        }

        if (richestParticipant && richestParticipant !== this.bountyParticipant) {
            this.bountyParticipant = richestParticipant;
            const message = `${richestParticipant.name} становится главной целью! Награда за его голову удвоена!`;
            broadcastMessage(message, createHordeColor(255, 255, 100, 100));
        }
    }

    private checkAndReassignTargets(): void {
        if (!this.settings.enableTargetSystem) {
            return;
        }

        const allParticipants = Array.from(this.participants.values());

        for (const participant of allParticipants) {
            const currentTarget = participant.target;

            // Переназначаем цель, если ее нет, она побеждена или стала союзником
            if (!currentTarget || currentTarget.isDefeated || currentTarget.teamId === participant.teamId) {
                this.assignNewTargetFor(participant, allParticipants);
            }
        }
    }

    private assignNewTargetFor(participant: FfaParticipant, allParticipants: FfaParticipant[]): void {
        const potentialTargets = allParticipants.filter(p =>
            p.id !== participant.id &&
            p.teamId !== participant.teamId &&
            !p.isDefeated
        );

        const newTarget = potentialTargets.length > 0
            ? potentialTargets[ActiveScena.GetRealScena().Context.Randomizer.RandomNumber(0, potentialTargets.length - 1)]
            : null;

        // Отправляем сообщения, только если цель действительно изменилась
        if (participant.target?.id !== newTarget?.id) {
            participant.target = newTarget;

            if (newTarget) {
                // Сообщение для атакующего
                const msgForAttacker = createGameMessageWithSound(
                    `Ваша новая цель: ${newTarget.name}!`,
                    newTarget.settlement.SettlementColor
                );
                participant.settlement.Messages.AddMessage(msgForAttacker);

                // Сообщение для цели
                const msgForTarget = createGameMessageWithSound(
                    `Вы стали целью для ${participant.name}!`,
                    participant.settlement.SettlementColor
                );
                newTarget.settlement.Messages.AddMessage(msgForTarget);
            }
        }
    }

    private checkBattleSummaries(gameTickNum: number): void {
        if (!this.settings.enableBattleSummaryMessages) {
            return;
        }

        for (const participant of Array.from(this.participants.values())) {
            // Проверяем, была ли начата битва и прошло ли достаточно времени с момента последнего получения очков
            if (participant.lastPowerPointGainTick > 0 &&
                gameTickNum > participant.lastPowerPointGainTick + this.settings.battleSummaryTimeoutTicks) {

                const battlePoints = Math.round(participant.currentBattlePowerPoints);

                if (battlePoints > 0) {
                    const message = createGameMessageWithSound(
                        `В результате последней битвы вы заработали ${battlePoints} очков силы.`,
                        participant.settlement.SettlementColor
                    );
                    participant.settlement.Messages.AddMessage(message);
                }

                // Сбрасываем счетчики битвы
                participant.currentBattlePowerPoints = 0;
                participant.lastPowerPointGainTick = 0;
            }
        }
    }

    private processVassalTributes(): void {
        for (const team of Array.from(this.teams.values())) {
            for (const vassal of team.vassals) {
                vassal.payTribute();
            }
        }
    }

    private processSuzerainGenerosity(): void {
        for (const team of Array.from(this.teams.values())) {
            team.distributeGenerosity();
        }
    }

    private promoteNewSuzerains(): void {
        for (const team of Array.from(this.teams.values())) {
            team.promoteNewSuzerainIfNeeded();
        }
    }

    private checkForDefeatedParticipants(): void {
        for (const participant of Array.from(this.participants.values())) {
            if (!participant.isDefeated && participant.castle.IsDead) {
                participant.isDefeated = true;
            }
        }
    }

    private processTeamMigrations(gameTickNum: number): void {
        const defeatedParticipants = Array.from(this.participants.values()).filter(p => p.isDefeated);

        for (const defeated of defeatedParticipants) {
            const loserTeam = this.teams.get(defeated.teamId);
            if (!loserTeam) {
                this.log.error(`Не найдена команда для побежденного участника ${defeated.name} (teamId: ${defeated.teamId})`);
                continue;
            }

            const winner = this.findWinnerFor(defeated);
            if (!winner) {
                this.log.warning(`Не удалось определить победителя для побежденного участника ${defeated.name}. Восстанавливаем замок.`);
                defeated.respawnCastle();
                defeated.isDefeated = false;
                continue;
            }

            const winnerTeam = this.teams.get(winner.teamId);
            if (!winnerTeam) {
                this.log.error(`Не найдена команда для победителя ${winner.name} (teamId: ${winner.teamId})`);
                continue;
            }

            // Логика зависит от того, кто был побежден: сюзерен или вассал
            if (defeated.isSuzerain()) {
                // =================================================
                // === Сценарий: Побежден Сюзерен (вся команда) ===
                // =================================================
                if (this.settings.weakenSnowballEffect) {
                    // --- НОВАЯ ЛОГИКА: ОСЛАБЛЕНИЕ СНЕЖНОГО КОМА ---
                    this.log.info(`Сюзерен ${defeated.name} побежден ${winner.name}. Эффект снежного кома ослаблен.`);

                    // 1. Победитель забирает только сюзерена
                    winnerTeam.shareSpoils(defeated, 0.20); // Трофеи за сюзерена
                    winnerTeam.addVassal(defeated);
                    broadcastMessage(`${winner.name} победил сюзерена ${defeated.name} и сделал его своим вассалом!`, winnerTeam.suzerain.settlement.SettlementColor);

                    // 2. Вассалы проигравшего становятся независимыми
                    const formerVassals = loserTeam.vassals;
                    if (formerVassals.length > 0) {
                        broadcastMessage(`Вассалы ${defeated.name} обретают независимость!`, loserTeam.suzerain.settlement.SettlementColor);
                        for (const vassal of formerVassals) {
                            // Каждый бывший вассал создает новую команду
                            const newTeam = new Team(vassal.id, vassal, this.settings);
                            this.teams.set(newTeam.id, newTeam);
                            this.log.info(`Бывший вассал ${vassal.name} создал новую команду (id: ${newTeam.id}).`);
                            
                            // Объявляем войну всем существующим командам.
                            // Мир с командой-победителем будет установлен позже, когда для нее вызовется startTemporaryPeace.
                            const allOtherTeams = Array.from(this.teams.values()).filter(t => t.id !== newTeam.id);
                            newTeam.setWarStatusWithAll(allOtherTeams);
                        }
                    }

                    // 3. Удаляем старую команду
                    this.teams.delete(loserTeam.id);

                    // 4. Сбрасываем флаг поражения только для бывшего сюзерена
                    defeated.isDefeated = false;

                } else {
                    // --- СТАРАЯ ЛОГИКА: ПОЛНОЕ ПОГЛОЩЕНИЕ ---
                    this.log.info(`Сюзерен ${defeated.name} (команда ${loserTeam.id}) был побежден ${winner.name}. Вся команда переходит к победителю.`);

                    const allLosers = loserTeam.getMembers();
                    for (const member of allLosers) {
                        // Распределяем трофеи за каждого члена проигравшей команды
                        const takenPercentage = member.isSuzerain() ? 0.20 : 0.10; // 20% за сюзерена, 10% за вассала
                        winnerTeam.shareSpoils(member, takenPercentage);
                    }

                    // Перемещаем всех членов проигравшей команды в команду победителя
                    winnerTeam.addSuzerainAndVassals(loserTeam.suzerain, loserTeam.vassals);
                    
                    // Удаляем старую, теперь пустую, команду
                    this.teams.delete(loserTeam.id);

                    broadcastMessage(`${winner.name} разгромил королевство ${defeated.name}! Команда проигравшего присоединяется к победителю.`, winnerTeam.suzerain.settlement.SettlementColor);
                    
                    // Сбрасываем флаг поражения для всех, кто перешел
                    allLosers.forEach(member => member.isDefeated = false);
                }
            } else {
                // =================================================
                // === Сценарий: Побежден Вассал (один участник) ===
                // =================================================
                this.log.info(`Вассал ${defeated.name} (команда ${loserTeam.id}) был побежден ${winner.name} и переходит в команду ${winnerTeam.id}.`);

                // Распределяем трофеи только за побежденного вассала
                const takenPercentage = 0.10; // 10% за вассала
                winnerTeam.shareSpoils(defeated, takenPercentage);

                // Перемещаем вассала
                loserTeam.removeVassal(defeated);
                winnerTeam.addVassal(defeated);

                broadcastMessage(`${winner.name} захватил вассала ${defeated.name} у ${loserTeam.suzerain.name}!`, winnerTeam.suzerain.settlement.SettlementColor);
                
                // Сбрасываем флаг поражения только для него
                defeated.isDefeated = false;
            }

            // После любого захвата команда-победитель получает временный мир
            this.startTemporaryPeace(winnerTeam, gameTickNum);
            const peaceDurationMinutes = Math.round(this.settings.temporaryPeaceDurationTicks / 50 / 60);
            broadcastMessage(`Команда ${winnerTeam.suzerain.name} получает временный мир на ${peaceDurationMinutes} мин. для восстановления.`, winnerTeam.suzerain.settlement.SettlementColor);
        }

        // Если произошли изменения в составах команд, нужно переназначить цели
        if (defeatedParticipants.length > 0) {
            this.checkAndReassignTargets();
        }
    }

    private findWinnerFor(defeated: FfaParticipant): FfaParticipant | null {
        let maxDamage = 0;
        let winner: FfaParticipant | null = null;

        for (const participant of Array.from(this.participants.values())) {
            if (participant.teamId === defeated.teamId) continue;

            const damage = participant.damageDealtTo.get(defeated.id) || 0;
            if (damage > maxDamage) {
                maxDamage = damage;
                winner = participant;
            }
        }
        return winner;
    }

    private startTemporaryPeace(team: Team, gameTickNum: number): void {
        const allTeams = Array.from(this.teams.values());
        team.setPeaceStatusWithAll(allTeams);
        team.peaceUntilTick = gameTickNum + this.settings.temporaryPeaceDurationTicks;
    }

    private managePeaceTreaties(gameTickNum: number): void {
        const allTeams = Array.from(this.teams.values());
        for (const team of allTeams) {
            if (team.peaceUntilTick > 0 && gameTickNum > team.peaceUntilTick) {
                this.log.info(`Мирный договор для команды ${team.suzerain.name} истек.`);
                team.peaceUntilTick = 0;

                // Просто объявляем войну всем остальным командам.
                // Логика коалиций обрабатывается в manageCoalitions.
                team.setWarStatusWithAll(allTeams);

                broadcastMessage(`Мирный договор для команды ${team.suzerain.name} закончился! Они снова в бою!`, team.suzerain.settlement.SettlementColor);
            }
        }
    }

    private manageCoalitions(): void {
        if (!this.settings.enableCoalitionsAgainstLeader) {
            return;
        }

        const dominantTeam = this.findDominantTeam();
        if (!dominantTeam) {
            return; // Нет доминирующей команды, коалиция не нужна.
        }

        const otherTeams = Array.from(this.teams.values()).filter(t => t.id !== dominantTeam.id);
        if (otherTeams.length <= 1) {
            return; // Не с кем объединяться или коалиция уже сформирована.
        }

        this.log.info(`Обнаружена доминирующая команда ${dominantTeam.suzerain.name}. Формируется коалиция.`);

        // 1. Находим сильнейшего сюзерена среди остальных для лидерства в коалиции.
        const coalitionLeaderTeam = otherTeams.reduce((prev, current) => 
            (prev.suzerain.powerPoints > current.suzerain.powerPoints) ? prev : current
        );

        // 2. Объединяем все остальные команды в команду лидера коалиции.
        const teamsToMerge = otherTeams.filter(t => t.id !== coalitionLeaderTeam.id);
        for (const teamToMerge of teamsToMerge) {
            coalitionLeaderTeam.addSuzerainAndVassals(teamToMerge.suzerain, teamToMerge.vassals);
            this.teams.delete(teamToMerge.id);
            this.log.info(`Команда ${teamToMerge.suzerain.name} (id: ${teamToMerge.id}) расформирована и присоединилась к коалиции.`);
        }

        // 3. Устанавливаем дипломатию для новой коалиции.
        coalitionLeaderTeam.setWarStatusWithAll([dominantTeam]);

        // 4. Сообщаем всем игрокам.
        broadcastMessage(
            `Команда ${dominantTeam.suzerain.name} стала слишком сильной! ` +
            `Остальные игроки объединились в коалицию под предводительством ${coalitionLeaderTeam.suzerain.name}, чтобы дать отпор!`,
            coalitionLeaderTeam.suzerain.settlement.SettlementColor
        );

        // После формирования коалиции, переназначаем цели
        this.checkAndReassignTargets();
    }

    private findDominantTeam(): Team | null {
        const totalPlayers = this.participants.size;
        for (const team of Array.from(this.teams.values())) {
            if (team.getMemberCount() > totalPlayers / 2) {
                return team;
            }
        }
        return null;
    }

    private processPowerPointRewards(gameTickNum: number): void {
        for (const participant of Array.from(this.participants.values())) {
            if (gameTickNum >= participant.nextRewardTime) {
                participant.givePowerPointReward();
            }
        }
    }

    private checkForGameEnd(): void {
        if (this.teams.size === 1) {
            this.isGameFinished = true;
            const winnerTeam = this.teams.values().next().value as Team;
            const winnerName = winnerTeam.suzerain.name;

            broadcastMessage(`Единственным правителем этих земель теперь является ${winnerName}!`, winnerTeam.suzerain.settlement.SettlementColor);

            for (const p of Array.from(this.participants.values())) {
                if (p.teamId === winnerTeam.id) {
                    p.settlement.Existence.ForceVictory();
                } else {
                    p.settlement.Existence.ForceTotalDefeat();
                }
            }
        }
    }

    private updateDecorators(): void {
        for (const participant of Array.from(this.participants.values())) {
            const castle = participant.castle;
            if (!castle || castle.IsDead) continue;

            this.updatePowerPointsDecorator(participant);
            this.updateStatusDecorator(participant);
            this.updateTargetDecorator(participant);
            this.updateCastleFrame(participant);
        }
    }

    private updatePowerPointsDecorator(participant: FfaParticipant): void {
        const decorator = this.powerPointDecorators.get(participant.id);
        if (decorator) {
            const resourceReward = Math.floor(this.settings.powerPointsRewardPercentage * participant.powerPoints);
            const peopleReward = Math.floor(0.02 * this.settings.powerPointsRewardPercentage * participant.powerPoints);
            decorator.Text = `Сила: ${Math.round(participant.powerPoints)} (+${resourceReward} рес., +${peopleReward} чел.)`;
            decorator.Position = createPoint(32 * (participant.castle.Cell.X - 1), Math.floor(32 * (participant.castle.Cell.Y - 1.3)));
        }
    }

    private updateStatusDecorator(participant: FfaParticipant): void {
        const decorator = this.statusDecorators.get(participant.id);
        if (decorator) {
            let statusText = participant.isSuzerain() ? "Сюзерен" : "Вассал";
            if (this.bountyParticipant && participant.id === this.bountyParticipant.id) {
                statusText += " (ГЛАВНАЯ ЦЕЛЬ)";
            }
            decorator.Text = statusText;
            decorator.Position = createPoint(Math.floor(32 * (participant.castle.Cell.X + 2.7)), Math.floor(32 * (participant.castle.Cell.Y + 3.6)));
        }
    }

    private updateTargetDecorator(participant: FfaParticipant): void {
        if (!this.settings.enableTargetSystem) {
            return;
        }
        const decorator = this.targetDecorators.get(participant.id);
        if (decorator) {
            const target = participant.target;
            if (target) {
                decorator.Text = `Цель: ${target.name}`;
                decorator.Color = target.settlement.SettlementColor;
                // Позиция чуть ниже декоратора очков силы
                decorator.Position = createPoint(Math.floor(32 * (participant.castle.Cell.X - 1)), Math.floor(32 * (participant.castle.Cell.Y - 1.8)));
            } else {
                decorator.Text = ""; // Скрываем, если цели нет
            }
        }
    }

    private updateCastleFrame(participant: FfaParticipant): void {
        const frame = this.castleFrames.get(participant.id);
        if (frame) {
            frame.Position = participant.castle.Position;
        }
    }

    private createDecoratorsForParticipant(participant: FfaParticipant): void {
        const settlementColor = participant.settlement.SettlementColor;
        const textColor = createHordeColor(255, Math.min(255, settlementColor.R + 128), Math.min(255, settlementColor.G + 128), Math.min(255, settlementColor.B + 128));

        const resourceReward = Math.floor(this.settings.powerPointsRewardPercentage * participant.powerPoints);
        const peopleReward = Math.floor(0.02 * this.settings.powerPointsRewardPercentage * participant.powerPoints);
        const ppText = `Сила: ${Math.round(participant.powerPoints)} (+${resourceReward} рес., +${peopleReward} чел.)`;
        const ppDecorator = spawnString(ActiveScena, ppText, createPoint(0, 0), 10 * 60 * 60 * 50);
        ppDecorator.Height = 22;
        ppDecorator.Color = textColor;
        ppDecorator.DrawLayer = DrawLayer.Birds;
        //@ts-ignore
        ppDecorator.Font = FontUtils.DefaultVectorFont;
        this.powerPointDecorators.set(participant.id, ppDecorator);

        const statusDecorator = spawnString(ActiveScena, participant.isSuzerain() ? "Сюзерен" : "Вассал", createPoint(0, 0), 10 * 60 * 60 * 50);
        statusDecorator.Height = 22;
        statusDecorator.Color = textColor;
        statusDecorator.DrawLayer = DrawLayer.Birds;
        //@ts-ignore
        statusDecorator.Font = FontUtils.DefaultVectorFont;
        this.statusDecorators.set(participant.id, statusDecorator);

        if (this.settings.enableTargetSystem) {
            const targetDecorator = spawnString(ActiveScena, "", createPoint(0, 0), 10 * 60 * 60 * 50);
            targetDecorator.Height = 22;
            targetDecorator.DrawLayer = DrawLayer.Birds;
            //@ts-ignore
            targetDecorator.Font = FontUtils.DefaultVectorFont;
            this.targetDecorators.set(participant.id, targetDecorator);
        }

        const frame = this.createCastleFrame(participant);
        this.castleFrames.set(participant.id, frame);
    }

    private createCastleFrame(participant: FfaParticipant): GeometryVisualEffect {
        const geometryCanvas = new GeometryCanvas();
        const width = participant.castleConfig.Size.Width * 32;
        const height = participant.castleConfig.Size.Height * 32;

        const points = host.newArr(Stride_Vector2, 5) as Stride_Vector2[];
        points[0] = new Stride_Vector2(Math.round(-0.7 * width), Math.round(-0.7 * height));
        points[1] = new Stride_Vector2(Math.round(0.7 * width), Math.round(-0.7 * height));
        points[2] = new Stride_Vector2(Math.round(0.7 * width), Math.round(0.7 * height));
        points[3] = new Stride_Vector2(Math.round(-0.7 * width), Math.round(0.7 * height));
        points[4] = points[0];

        const color = participant.settlement.SettlementColor;
        geometryCanvas.DrawPolyLine(points, new Stride_Color(color.R, color.G, color.B), 3.0, false);

        return spawnGeometry(ActiveScena, geometryCanvas.GetBuffers(), participant.castle.Position, 10 * 60 * 60 * 50);
    }

    private displayInitialMessages(gameTickNum: number): void {
        const color = createHordeColor(255, 255, 140, 140);
        let message = "";

        if (gameTickNum === 50 * 10) {
            message = "Правила игры:\n\n" +
                      "\t1. Все игроки находятся в состоянии войны (Каждый сам за себя).\n" +
                      "\t2. Уничтожьте вражеский замок, чтобы сделать его своим вассалом.";
        } else if (gameTickNum === 50 * 30) {
            message = `\t3. Вся проигравшая команда (сюзерен и вассалы) переходит под контроль победителя.\n` +
                      `\t4. Вассалы платят дань (ресурсы > ${this.settings.vassalResourceLimit} + 10% от очков силы) своему сюзерену.\n` +
                      `\t5. У вассалов есть лимит населения (${this.settings.vassalPopulationLimit} + 0.2% от очков силы).\n`;
        } else if (gameTickNum === 50 * 50) {
            message = `\t6. После победы ваша команда получает временный мирный договор на ${this.settings.temporaryPeaceDurationTicks / 50 / 60} мин.\n` +
                      `\t7. Когда договор истекает, вы снова в состоянии войны со всеми.\n` +
                      `\t8. Сюзерен проявляет щедрость (делится ресурсами), если его казна превышает ${this.settings.suzerainGenerosityThreshold}.\n`;
        } else if (gameTickNum === 50 * 70) {
            message = `\t9. Самый влиятельный игрок в команде (по очкам силы) становится сюзереном.\n` +
                      `\t10. После уплаты налогов и зарплат вы получаете ресурсы (${Math.round(this.settings.powerPointsRewardPercentage * 100)}% от очков силы) и людей (${(this.settings.powerPointsRewardPercentage * 0.02 * 100).toFixed(2)}% от очков силы).\n` +
                      `\t11. Нейтральным юнитам урон не наносится.\n`;
        } else if (gameTickNum === 50 * 85) {
            let message = "Включенные механики:\n";
            if (this.settings.enableTargetSystem) {
                message += "\t- Цели: Атакуйте назначенную цель для получения бонусных очков.\n";
            }
            if (this.settings.enableBountyOnLeader) {
                message += "\t- Награда за голову: Атакуйте лидера по очкам для получения бонуса.\n";
            }
            if (this.settings.enableCoalitionsAgainstLeader) {
                message += "\t- Коалиции: Слабые игроки объединяются против доминирующей команды.\n";
            }
            if (this.settings.weakenSnowballEffect) {
                message += "\t- Ослабление 'снежного кома': При поражении сюзерена его вассалы становятся свободными.\n";
            }
            if (this.settings.enableBattleSummaryMessages) {
                message += "\t- Итоги битвы: Получайте сводку о заработанных очках после боя.\n";
            }
            if (this.settings.enableInitialPeacePeriod) {
                message += `\t- Начальный мир: ${this.settings.initialPeaceDurationTicks / 50 / 60} минут на развитие.\n`;
            }
        } else if (gameTickNum === 50 * 95) {
            message = "Правила объявлены. Да начнется битва!";
        }

        if (message) {
            broadcastMessage(message, color);
        }
    }
}
