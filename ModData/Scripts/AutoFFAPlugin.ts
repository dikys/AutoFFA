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
    private participantPeaceUntilTick: Map<number, number> = new Map();
    private settlementUidToParticipantId: Map<string, number> = new Map();
    private unitCfgUidToPowerPerHp: Map<string, number> = new Map();

    private powerPointDecorators: Map<number, StringVisualEffect> = new Map();
    private statusDecorators: Map<number, StringVisualEffect> = new Map();
    private targetDecorators: Map<number, StringVisualEffect[]> = new Map();
    private castleFrames: Map<number, GeometryVisualEffect> = new Map();

    private isGameFinished = false;
    private readonly settings: AutoFFASettings;
    private bountyParticipant: FfaParticipant | null = null;
    private mapLinearSize: number = 1;
    private nextBountyCheckTick = 0;
    private initialPeaceEndTick = 0; // Тик, когда закончится начальный мир
    private readonly initialPowerPointsExchangeSetting: boolean;
    private powerExchangeTemporarilyDisabled: boolean = false;
    //private challengeSystemApplied = false; // Флаг, чтобы механика применилась лишь раз

    // ==================================================================================================
    // Конструктор
    // ==================================================================================================

    constructor(settings: AutoFFASettings) {
        super("Auto FFA (OOP)");
        this.settings = settings;
        this.initialPowerPointsExchangeSetting = this.settings.enablePowerPointsExchange;
        this.log.logLevel = LogLevel.Info; // Включаем подробное логирование по умолчанию
    }

    // ==================================================================================================
    // Переопределения HordePluginBase
    // ==================================================================================================

    public onFirstRun(): void {
        broadcastMessage("Добро пожаловать в AutoFFA!\nКаждый сам за себя! Уничтожьте вражеский замок, чтобы сделать его своим вассалом.", createHordeColor(255, 255, 140, 140));
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
            case this.TICK_OFFSET.PEACE_TREATY_CHECK: this.managePeaceTreaties(gameTickNum); this.manageParticipantPeaceTreaties(gameTickNum); break;
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
    // Вспомогательные методы
    // ==================================================================================================

    private getTargetTeamMemberCount(participant: FfaParticipant): number {
        if (!this.settings.enableTargetSystem) {
            return 0;
        }
        const target = participant.target;
        if (target) {
            const targetTeam = this.teams.get(target.teamId);
            if (targetTeam) {
                return targetTeam.getMemberCount();
            } else {
                // Если команда цели не найдена, это может быть переходное состояние.
                // Безопаснее вернуть 0, чтобы избежать неверных расчетов смещения.
                this.log.warning(`[${participant.name}] getTargetTeamMemberCount: Не удалось найти команду для цели ${target.name} (teamId: ${target.teamId}). Возвращаем 0.`);
                return 0;
            }
        }
        return 0;
    }


    // ==================================================================================================
    // Инициализация
    // ==================================================================================================

    private initialize(): void {
        this.log.info("Инициализация AutoFFA...");

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
        if (this.settings.isChallengeSystemEnabled) {
            this.applyChallengeSystemBalance();
            this.checkAndReassignTargets();
            this.updateDecorators(); // Немедленно обновляем UI, чтобы отразить новую структуру команд
        }

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

    private applyChallengeSystemBalance(): void {
        const challengers: FfaParticipant[] = [];
        const others: FfaParticipant[] = [];
        const challengerNames = ['князъ', 'повелитель'];

        for (const participant of Array.from(this.participants.values())) {
            const nameLower = participant.name.toLowerCase();
            if (challengerNames.some(cn => nameLower.includes(cn))) {
                challengers.push(participant);
            } else {
                others.push(participant);
            }
        }

        if (challengers.length === 0 || others.length === 0) {
            this.log.info("Недостаточно участников для 'Вызова системе', механика не применяется.");
            return; // Механика не применяется
        }

        const challengerTeamName = challengers.map(p => p.name).join(' и ');
        broadcastMessage(
            `Игроки ${challengerTeamName} бросили вызов системе и будут наказаны!`,
            createHordeColor(255, 255, 100, 100)
        );
        this.log.info(`Запуск 'Вызова системе'. Челленджеры: ${challengerTeamName}. Остальные: ${others.map(p => p.name).join(', ')}.`);

        // 1. Определяем сюзеренов для каждой новой команды
        challengers.sort((a, b) => b.powerPoints - a.powerPoints);
        const challengerSuzerain = challengers[0];

        others.sort((a, b) => b.powerPoints - a.powerPoints);
        const otherSuzerain = others[0];

        this.log.info(`Новый сюзерен челленджеров: ${challengerSuzerain.name}. Новый сюзерен остальных: ${otherSuzerain.name}.`);

        // 2. Получаем главные команды, которые останутся
        const challengerTeam = this.teams.get(challengerSuzerain.id);
        const otherTeam = this.teams.get(otherSuzerain.id);

        if (!challengerTeam || !otherTeam) {
            this.log.error("КРИТИЧЕСКАЯ ОШИБКА: Не удалось найти исходные команды для новых сюзеренов.");
            return;
        }

        // 3. Собираем всех участников, которых нужно переместить в новые команды
        const participantsToMove = Array.from(this.participants.values()).filter(
            p => p.id !== challengerSuzerain.id && p.id !== otherSuzerain.id
        );

        this.log.info(`Перемещаем ${participantsToMove.length} участников в новые команды.`);

        // 4. Перемещаем участников и удаляем их старые команды
        for (const participant of participantsToMove) {
            const isChallenger = challengers.some(c => c.id === participant.id);
            const targetTeam = isChallenger ? challengerTeam : otherTeam;

            // participant.teamId в данный момент - это его собственный ID, так как он был сюзереном своей команды 
            const oldTeamId = participant.teamId; 
            
            this.log.info(`Перемещаем ${participant.name} из старой команды ${oldTeamId} в команду ${targetTeam.suzerain.name}.`);
            targetTeam.addVassal(participant); // addVassal обновит participant.teamId

            // Удаляем старую команду участника
            if (this.teams.has(oldTeamId)) {
                this.teams.delete(oldTeamId);
                this.log.info(`Старая команда ${oldTeamId} удалена.`);
            } else {
                this.log.warning(`Не удалось найти старую команду ${oldTeamId} для удаления.`);
            }
        }

        // 5. Устанавливаем войну между двумя итоговыми командами и мир внутри них
        this.log.info(`Устанавливаем дипломатию между командой ${challengerTeam.suzerain.name} и ${otherTeam.suzerain.name}.`);
        for (const member1 of challengerTeam.getMembers()) {
            for (const member2 of otherTeam.getMembers()) {
                DiplomacyManager.setDiplomacy(member1, member2, DiplomacyStatus.War);
            }
        }
        // challengerTeam.setPeaceWithinTeam();
        // otherTeam.setPeaceWithinTeam();
        
        this.log.info(`'Вызов системе' завершен. Итоговые команды: ${this.teams.size}.`);
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

        // Бонус дается за атаку любого члена команды-цели
        if (this.settings.enableTargetSystem && attacker.target && victim.teamId === attacker.target.teamId) {
            deltaPoints *= this.settings.targetPowerPointsMultiplier;
        }

        if (deltaPoints > 0) {
            attacker.powerPoints += deltaPoints;
            // Урон для распределения трофеев (очков) всегда учитывается
            attacker.damageDealtTo.set(victim.id, (attacker.damageDealtTo.get(victim.id) || 0) + deltaPoints);

            // Урон по замку учитывается отдельно для определения победителя
            if (damageArgs.VictimUnit.Id === victim.castle.Id) {
                attacker.castleDamageDealtTo.set(victim.id, (attacker.castleDamageDealtTo.get(victim.id) || 0) + deltaPoints);
            }

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
        this.log.info("Проверка и назначение 'Награды за голову'.");

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
            this.log.info(`Новая 'Награда за голову' назначена на ${richestParticipant.name} (очки: ${Math.round(maxPower)}).`);
            this.bountyParticipant = richestParticipant;
            const message = `${richestParticipant.name} становится главной целью! Награда за его голову удвоена!`;
            broadcastMessage(message, createHordeColor(255, 255, 100, 100));
        } else if (richestParticipant) {
            this.log.info(`'Награда за голову' остается у ${richestParticipant.name}.`);
        } else {
            this.log.info("Не удалось найти кандидата для 'Награды за голову'.");
        }
    }

    private checkAndReassignTargets(): void {
        if (!this.settings.enableTargetSystem) {
            return;
        }
        this.log.info("Проверка и переназначение целей...");

        const allTeams = Array.from(this.teams.values());
        const gameTickNum = BattleController.GameTimer.GameFramesCounter;
        const randomizer = ActiveScena.GetRealScena().Context.Randomizer;

        // Собираем команды, которые не находятся в состоянии мира
        const teamsToPair = new Map<number, Team>();
        for (const team of allTeams) {
            if (team.peaceUntilTick <= gameTickNum) {
                teamsToPair.set(team.id, team);
            } else {
                this.log.info(`Команда ${team.suzerain.name} находится в мире до тика ${team.peaceUntilTick} (сейчас ${gameTickNum}), исключаем из подбора пар.`);
            }
        }
        this.log.info(`Команды, доступные для подбора пар: ${Array.from(teamsToPair.values()).map(t => t.suzerain.name).join(', ') || 'нет'}`);

        const teamsToReassign: Team[] = [];

        // 1. Ищем существующие стабильные (симметричные) пары и откладываем их
        const processedIds = new Set<number>();
        this.log.info("Этап 1: Поиск стабильных симметричных пар.");
        for (const teamA of Array.from(teamsToPair.values())) {
            if (processedIds.has(teamA.id)) {
                this.log.info(`Команда ${teamA.suzerain.name} уже обработана, пропускаем.`);
                continue;
            }

            const targetParticipantB = teamA.suzerain.target;
            if (targetParticipantB) {
                const teamB = teamsToPair.get(targetParticipantB.teamId);
                
                // Проверяем, что цель симметрична:
                // 1. Команда цели (teamB) существует и доступна для подбора.
                // 2. Цель команды B - это команда A.
                // 3. Команда B != команде A
                if (teamB && teamB.suzerain.target?.teamId === teamA.id && teamA.id !== teamB.id) {
                    processedIds.add(teamA.id);
                    processedIds.add(teamB.id);
                    this.log.info(`Найдена и сохранена симметричная цель: ${teamA.suzerain.name} (id: ${teamA.id}) vs ${teamB.suzerain.name} (id: ${teamB.id}).`);
                } else {
                     this.log.info(`У команды ${teamA.suzerain.name} есть цель ${targetParticipantB.name}, но она не симметрична или цель в мире.`);
                }
            } else {
                this.log.info(`У команды ${teamA.suzerain.name} нет цели.`);
            }
        }
        this.log.info(`Обработанные (сохраненные) ID команд: ${Array.from(processedIds).join(', ') || 'нет'}`);

        // 2. Собираем все остальные команды (у которых нет симметричной пары) для переназначения
        this.log.info("Этап 2: Сбор команд для переназначения.");
        for (const team of Array.from(teamsToPair.values())) {
            if (!processedIds.has(team.id)) {
                teamsToReassign.push(team);
                this.log.info(`Команда ${team.suzerain.name} (id: ${team.id}) добавлена в список на переназначение.`);
            }
        }
        
        // Также принудительно сбрасываем цели у команд, которые ушли в мир, но по какой-то причине все еще имеют цель
        this.log.info("Проверка и сброс целей у команд в мире.");
        for (const team of allTeams) {
            if (team.peaceUntilTick > gameTickNum && team.suzerain.target) {
                this.log.info(`Команда ${team.suzerain.name} находится в мире, но имеет цель. Принудительно сбрасываем цель.`);
                this.assignNewTargetForTeam(team, null);
            }
        }

        if (teamsToReassign.length === 0) {
            this.log.info("Нет команд для переназначения. Все текущие цели корректны и симметричны.");
            return;
        }

        this.log.info(`Итоговый список команд для переназначения: ${teamsToReassign.map(t => t.suzerain.name).join(', ')}.`);

        // 3. Сбрасываем текущие (несимметричные) цели у "проблемных" команд
        this.log.info("Этап 3: Сброс старых несимметричных целей.");
        for (const team of teamsToReassign) {
            if (team.suzerain.target) {
                this.log.info(`Сбрасываем старую цель у команды ${team.suzerain.name}.`);
                this.assignNewTargetForTeam(team, null);
            }
        }

        // 4. Перемешиваем и создаем новые пары
        this.log.info("Этап 4: Перемешивание и создание новых пар.");
        for (let i = teamsToReassign.length - 1; i > 0; i--) {
            const j = randomizer.RandomNumber(0, i);
            [teamsToReassign[i], teamsToReassign[j]] = [teamsToReassign[j], teamsToReassign[i]];
        }
        this.log.info(`Порядок команд после перемешивания: ${teamsToReassign.map(t => t.suzerain.name).join(', ')}.`);

        while (teamsToReassign.length >= 2) {
            const teamA = teamsToReassign.pop()!;
            const teamB = teamsToReassign.pop()!;
            this.log.info(`Создаем новую пару: ${teamA.suzerain.name} vs ${teamB.suzerain.name}.`);
            this.assignNewTargetForTeam(teamA, teamB);
            this.assignNewTargetForTeam(teamB, teamA);
        }

        if (teamsToReassign.length === 1) {
            this.log.info(`Осталась одна команда без пары: ${teamsToReassign[0].suzerain.name}. Она будет ждать следующего цикла.`);
        }

        this.log.info("Переназначение целей завершено.");
    }

    private assignNewTargetForTeam(team: Team, targetTeam: Team | null): void {
        const newTarget = targetTeam ? targetTeam.suzerain : null;
        const oldTarget = team.suzerain.target;
    
        // Отправляем сообщения, только если цель действительно изменилась
        if (oldTarget?.id === newTarget?.id) {
            return;
        }
    
        // Устанавливаем новую цель для всех членов команды
        for (const member of team.getMembers()) {
            member.target = newTarget;
        }
    
        if (newTarget && targetTeam) {
            this.log.info(`Команде ${team.suzerain.name} (id: ${team.id}) назначена новая цель: команда ${targetTeam.suzerain.name} (id: ${targetTeam.id}).`);
            // Сообщение для атакующей команды
            const msgForAttacker = createGameMessageWithSound(`Ваша новая цель: команда ${targetTeam.suzerain.name}!`, newTarget.settlement.SettlementColor);
            for (const member of team.getMembers()) {
                member.settlement.Messages.AddMessage(msgForAttacker);
            }
    
            // Сообщение для команды-цели
            const msgForTarget = createGameMessageWithSound(`Вы стали целью для команды ${team.suzerain.name}!`, team.suzerain.settlement.SettlementColor);
            for (const member of targetTeam.getMembers()) {
                member.settlement.Messages.AddMessage(msgForTarget);
            }
        } else {
            this.log.info(`С команды ${team.suzerain.name} (id: ${team.id}) снята цель.`);
        }
    }

    private checkBattleSummaries(gameTickNum: number): void {
        if (!this.settings.enableBattleSummaryMessages) {
            return;
        }
        this.log.info("Проверка итогов битв.");
        let summariesSent = 0;

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
                    this.log.info(`Отправлен итог битвы для ${participant.name}: ${battlePoints} очков.`);
                    summariesSent++;
                }

                // Сбрасываем счетчики битвы
                participant.currentBattlePowerPoints = 0;
                participant.lastPowerPointGainTick = 0;
            }
        }
        if (summariesSent > 0) {
            this.log.info(`Проверка завершена. Отправлено ${summariesSent} итогов битв.`);
        }
    }

    private processVassalTributes(): void {
        this.log.info("Начинаем обработку дани с вассалов. teams.length = ", this.teams.size);
        let tributesPaidCount = 0;
        for (const team of Array.from(this.teams.values())) {
            for (const vassal of team.vassals) {
                if (vassal.payTribute()) {
                    tributesPaidCount++;
                    this.log.info(`Вассал ${vassal.name} (команда ${team.suzerain.name}) уплатил дань.`);
                }
            }
        }
        if (tributesPaidCount > 0) {
            this.log.info(`Обработка дани завершена. Всего уплатили: ${tributesPaidCount}.`);
        }
    }

    private processSuzerainGenerosity(): void {
        this.log.info("Начинаем обработку щедрости сюзеренов. teams.length = ", this.teams.size);
        let generousSuzerainsCount = 0;
        for (const team of Array.from(this.teams.values())) {
            this.log.info("team.id = ", team.id, " team.suzerain.id = ", team.suzerain.id);
            if (team.distributeGenerosity()) {
                generousSuzerainsCount++;
                this.log.info(`Сюзерен ${team.suzerain.name} проявил щедрость к своим вассалам.`);
            }
        }
        if (generousSuzerainsCount > 0) {
            this.log.info(`Обработка щедрости завершена. Всего щедрых сюзеренов: ${generousSuzerainsCount}.`);
        }
    }

    private promoteNewSuzerains(): void {
        this.log.info("Проверка на смену сюзеренов в командах.");

        // Если обмен очками был временно отключен в предыдущем цикле, восстанавливаем его до исходного значения
        if (this.powerExchangeTemporarilyDisabled) {
            this.settings.enablePowerPointsExchange = this.initialPowerPointsExchangeSetting;
            this.powerExchangeTemporarilyDisabled = false;
            this.log.info(`Обмен очками силы восстановлен в состояние по-умолчанию: ${this.initialPowerPointsExchangeSetting}.`);
        }

        let promotionsCount = 0;
        for (const team of Array.from(this.teams.values())) {
            if (team.promoteNewSuzerainIfNeeded()) {
                promotionsCount++;
                this.log.info(`В команде ${team.id} произошла смена власти. Новый сюзерен: ${team.suzerain.name}.`);
            }
        }

        if (promotionsCount > 0) {
            this.log.info(`Проверка завершена. Произошло ${promotionsCount} смен(ы) власти.`);
            // Если произошла смена власти и обмен очками был включен, временно отключаем его, чтобы избежать зацикливания
            if (this.settings.enablePowerPointsExchange) {
                this.settings.enablePowerPointsExchange = false;
                this.powerExchangeTemporarilyDisabled = true;
                this.log.info("Обмен очками силы временно отключен на 1 цикл для стабилизации власти.");
            }
            // Переназначаем цели, чтобы обеспечить симметрию после смены власти
            this.log.info("Произошла смена власти, перепроверяем цели команд.");
            this.checkAndReassignTargets();
        }
    }

    private checkForDefeatedParticipants(): void {
        this.log.info("Проверка на наличие побежденных участников.");
        let newlyDefeatedCount = 0;
        for (const participant of Array.from(this.participants.values())) {
            if (!participant.isDefeated && participant.castle.IsDead) {
                participant.isDefeated = true;
                newlyDefeatedCount++;
                this.log.info(`Участник ${participant.name} был побежден (замок разрушен).`);
            }
        }
        if (newlyDefeatedCount > 0) {
            this.log.info(`Проверка завершена. Обнаружено ${newlyDefeatedCount} новых побежденных.`);
        }
    }

    private processTeamMigrations(gameTickNum: number): void {
        const defeatedParticipants = Array.from(this.participants.values()).filter(p => p.isDefeated);

        if (defeatedParticipants.length > 0) {
            this.log.info(`Начинаем обработку миграций для ${defeatedParticipants.length} побежденных участников: ${defeatedParticipants.map(p => p.name).join(', ')}.`);
        }

        for (const defeated of defeatedParticipants) {
            // Проверяем, не был ли этот участник уже обработан в составе другой команды в этой же итерации
            if (!defeated.isDefeated) {
                this.log.info(`Участник ${defeated.name} уже был обработан (например, как часть поглощенной команды). Пропускаем.`);
                continue;
            }

            this.log.info(`Обработка поражения для ${defeated.name} (id: ${defeated.id}, teamId: ${defeated.teamId}).`);
            const loserTeam = this.teams.get(defeated.teamId);
            if (!loserTeam) {
                this.log.error(`КРИТИЧЕСКАЯ ОШИБКА: Не найдена команда (id: ${defeated.teamId}) для побежденного участника ${defeated.name}.`);
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
                this.log.error(`КРИТИЧЕСКАЯ ОШИБКА: Не найдена команда (id: ${winner.teamId}) для победителя ${winner.name}.`);
                continue;
            }

            const newlyAcquiredParticipants: FfaParticipant[] = [];

            // Логика зависит от того, кто был побежден: сюзерен или вассал
            if (defeated.isSuzerain()) {
                this.log.info(`Сценарий: Сюзерен ${defeated.name} (команда ${loserTeam.id}) побежден ${winner.name}. Вся команда (${loserTeam.getMembers().map(m => m.name).join(', ')}) переходит к победителю.`);

                const allLosers = [ loserTeam.suzerain ];
                for (const member of allLosers) {
                    // Распределяем трофеи за каждого члена проигравшей команды
                    const takenPercentage = member.isSuzerain() ? 0.20 : 0.10; // 20% за сюзерена, 10% за вассала
                    winnerTeam.shareSpoils(member, takenPercentage);
                }

                // Перемещаем всех членов проигравшей команды в команду победителя
                this.log.info(`Перемещаем всех членов команды ${loserTeam.id} в команду ${winnerTeam.id}.`);
                loserTeam.removeSuzerain();
                winnerTeam.addVassal(allLosers[0]);
                newlyAcquiredParticipants.push(...allLosers);
                
                // Удаляем старую, теперь пустую, команду
                this.log.info(`Удаляем старую команду ${defeated.name} (id: ${loserTeam.id}).`);
                if (!loserTeam.suzerain) {
                    this.teams.delete(loserTeam.id);
                }

                broadcastMessage(`${winner.name} разгромил королевство ${defeated.name}! Команда проигравшего присоединяется к победителю.`, winnerTeam.suzerain.settlement.SettlementColor);
                this.log.info(`Сбрасываем флаги поражения для всех членов бывшей команды ${defeated.name}.`);
                // Сбрасываем флаг поражения для всех, кто перешел
                allLosers.forEach(member => member.isDefeated = false);
            } else {
                // =================================================
                // === Сценарий: Побежден Вассал (один участник) ===
                // =================================================
                this.log.info(`Сценарий: Вассал ${defeated.name} (команда ${loserTeam.id}) побежден ${winner.name} и переходит в команду ${winnerTeam.id}.`);

                // Распределяем трофеи только за побежденного вассала
                const takenPercentage = 0.10; // 10% за вассала
                winnerTeam.shareSpoils(defeated, takenPercentage);

                this.log.info(`Перемещаем вассала ${defeated.name} из команды ${loserTeam.suzerain.name} в команду ${winnerTeam.suzerain.name}.`);
                // Перемещаем вассала
                loserTeam.removeVassal(defeated);
                winnerTeam.addVassal(defeated);
                newlyAcquiredParticipants.push(defeated);

                broadcastMessage(`${winner.name} захватил вассала ${defeated.name} у ${loserTeam.suzerain.name}!`, winnerTeam.suzerain.settlement.SettlementColor);
                
                // Сбрасываем флаг поражения только для него
                defeated.isDefeated = false;
            }

            // После любого захвата новые участники команды-победителя получают временный мир
            if (newlyAcquiredParticipants.length > 0) {
                this.log.info(`Новые участники команды ${winnerTeam.suzerain.name} (${newlyAcquiredParticipants.map(p => p.name).join(', ')}) получают временный мир.`);
                this.startTemporaryPeaceForParticipants(newlyAcquiredParticipants, gameTickNum);
                const peaceDurationMinutes = Math.round(this.settings.temporaryPeaceDurationTicks / 50 / 60);
                broadcastMessage(`Новые поселения команды ${winnerTeam.suzerain.name} получают временный мир на ${peaceDurationMinutes} мин. для восстановления.`, winnerTeam.suzerain.settlement.SettlementColor);
            }
        }

        if (defeatedParticipants.length > 0) {
            this.log.info(`Обработка миграций завершена.`);
            // Если произошли изменения в составах команд, нужно переназначить цели
            this.log.info(`Произошли изменения в составах команд, переназначаем цели.`);
            this.checkAndReassignTargets();
        }
    }

    private findWinnerFor(defeated: FfaParticipant): FfaParticipant | null {
        let maxDamage = 0;
        let winner: FfaParticipant | null = null;

        for (const participant of Array.from(this.participants.values())) {
            if (participant.teamId === defeated.teamId) continue;

            // Победитель определяется по урону, нанесенному именно замку.
            const damage = participant.castleDamageDealtTo.get(defeated.id) || 0;
            if (damage > maxDamage) {
                maxDamage = damage;
                winner = participant;
            }
        }
        return winner;
    }

    private startTemporaryPeaceForParticipants(participants: FfaParticipant[], gameTickNum: number): void {
        const allParticipants = Array.from(this.participants.values());
        const peaceDuration = this.settings.temporaryPeaceDurationTicks;

        for (const protectedParticipant of participants) {
            this.log.info(`Устанавливаем временный мир для ${protectedParticipant.name} на ${peaceDuration} тиков.`);
            for (const otherParticipant of allParticipants) {
                if (protectedParticipant.id !== otherParticipant.id) {
                    if (protectedParticipant.teamId == otherParticipant.teamId) {
                        DiplomacyManager.setDiplomacy(protectedParticipant, otherParticipant, DiplomacyStatus.Alliance);
                    } else {
                        DiplomacyManager.setDiplomacy(protectedParticipant, otherParticipant, DiplomacyStatus.Neutral);
                    }
                }
            }
            this.participantPeaceUntilTick.set(protectedParticipant.id, gameTickNum + peaceDuration);
        }
    }

    private manageParticipantPeaceTreaties(gameTickNum: number): void {
        if (this.participantPeaceUntilTick.size === 0) {
            return;
        }
        this.log.info("Проверка истекших индивидуальных мирных договоров.");
        
        const expiredParticipantIds: number[] = [];

        for (const participantId of Array.from(this.participantPeaceUntilTick.keys())) {
            var peaceUntilTick = this.participantPeaceUntilTick.get(participantId) as number;
            if (gameTickNum > peaceUntilTick) {
                const participant = this.participants.get(participantId);
                if (!participant || participant.isDefeated) {
                    this.log.warning(`Участник с ID ${participantId} не найден или побежден. Удаляем из списка индивидуального мира.`);
                    expiredParticipantIds.push(participantId);
                    continue;
                }

                const team = this.teams.get(participant.teamId);
                if (!team) {
                    this.log.error(`Не найдена команда для участника ${participant.name} (id: ${participant.id}, teamId: ${participant.teamId}) при окончании индивидуального мира.`);
                    expiredParticipantIds.push(participantId);
                    continue;
                }

                this.log.info(`Индивидуальный мирный договор для ${participant.name} истек. Восстанавливаем командную дипломатию.`);
                
                // Устанавливаем войну со всеми, кроме сокомандников
                const ownTeamId = participant.teamId;
                const allOtherParticipants = Array.from(this.participants.values()).filter(p => p.id !== participant.id);

                for (const other of allOtherParticipants) {
                    if (this.participantPeaceUntilTick.has(other.id)) {
                        continue;
                    }
                    if (other.teamId === ownTeamId) {
                        DiplomacyManager.setDiplomacy(participant, other, DiplomacyStatus.Alliance);
                    } else {
                        DiplomacyManager.setDiplomacy(participant, other, DiplomacyStatus.War);
                    }
                }
                
                broadcastMessage(`Игрок ${participant.name} снова в бою!`, participant.settlement.SettlementColor);
                expiredParticipantIds.push(participantId);
            }
        }

        if (expiredParticipantIds.length > 0) {
            this.log.info(`Истекло ${expiredParticipantIds.length} индивидуальных договоров.`);
            for (const id of expiredParticipantIds) {
                this.participantPeaceUntilTick.delete(id);
            }
        }
    }

    private managePeaceTreaties(gameTickNum: number): void {
        this.log.info("Проверка истекших мирных договоров.");
        let treatiesEnded = 0;
        const allTeams = Array.from(this.teams.values());
        this.log.info("allTeams.length = ", allTeams.length);
        for (const team of allTeams) {
            if (team.peaceUntilTick > 0 && gameTickNum > team.peaceUntilTick) {
                this.log.info(`Мирный договор для команды ${team.suzerain.name} истек.`);
                team.peaceUntilTick = 0;
                treatiesEnded++;

                // Просто объявляем войну всем остальным командам.
                // Логика коалиций обрабатывается в manageCoalitions.
                team.setWarStatusWithAll(allTeams);

                broadcastMessage(`Мирный договор для команды ${team.suzerain.name} закончился! Они снова в бою!`, team.suzerain.settlement.SettlementColor);
            }
        }
        if (treatiesEnded > 0) {
            this.log.info(`Проверка договоров завершена. Истекло ${treatiesEnded} договоров.`);
        }
    }

    private manageCoalitions(): void {
        if (!this.settings.enableCoalitionsAgainstLeader) {
            return;
        }
        this.log.info("Проверка необходимости создания коалиций.");

        const dominantTeam = this.findDominantTeam();
        if (!dominantTeam) {
            this.log.info("Доминирующая команда не найдена, коалиция не требуется.");
            return; // Нет доминирующей команды, коалиция не нужна.
        }

        const otherTeams = Array.from(this.teams.values()).filter(t => t.id !== dominantTeam.id);
        if (otherTeams.length <= 1) {
            this.log.info(`Доминирующая команда ${dominantTeam.suzerain.name} есть, но недостаточно других команд для создания коалиции.`);
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

        // 4. Принудительно назначаем цели: коалиция против доминатора.
        this.log.info(`Принудительное назначение целей после формирования коалиции: ${coalitionLeaderTeam.suzerain.name} vs ${dominantTeam.suzerain.name}.`);
        this.assignNewTargetForTeam(coalitionLeaderTeam, dominantTeam);
        this.assignNewTargetForTeam(dominantTeam, coalitionLeaderTeam);

        // 5. Сообщаем всем игрокам.
        broadcastMessage(
            `Команда ${dominantTeam.suzerain.name} стала слишком сильной! ` + 
            `Остальные игроки объединились в коалицию под предводительством ${coalitionLeaderTeam.suzerain.name}, чтобы дать отпор!`,
            coalitionLeaderTeam.suzerain.settlement.SettlementColor
        );

    }

    private findDominantTeam(): Team | null {
        const totalPlayers = this.participants.size;
        for (const team of Array.from(this.teams.values())) {
            if (team.getMemberCount() >= totalPlayers / 2) {
                return team;
            }
        }
        return null;
    }

    private processPowerPointRewards(gameTickNum: number): void {
        this.log.info("Начинаем обработку наград за очки силы.");
        let rewardsGivenCount = 0;
        for (const participant of Array.from(this.participants.values())) {
            if (gameTickNum >= participant.nextRewardTime) {
                if (participant.givePowerPointReward()) {
                    rewardsGivenCount++;
                    this.log.info(`Участник ${participant.name} получил награду за очки силы.`);
                }
            }
        }
        if (rewardsGivenCount > 0) {
            this.log.info(`Обработка наград завершена. Награждено ${rewardsGivenCount} участников.`);
        }
    }

    private checkForGameEnd(): void {
        if (this.teams.size === 1 && !this.isGameFinished) {
            this.log.info("Обнаружено условие окончания игры: осталась одна команда.");
            this.isGameFinished = true;
            const winnerTeam = this.teams.values().next().value as Team;
            const winnerName = winnerTeam.suzerain.name;
            this.log.info(`Победитель: команда ${winnerName} (id: ${winnerTeam.id}).`);

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
        this.log.info("Обновление декораторов.");
        const scena = ActiveScena.GetRealScena();
        const sceneWidthPx = scena.Size.Width * 32;
        const sceneHeightPx = scena.Size.Height * 32;
        const topMargin = 5; // Небольшой отступ сверху
        const rightMargin = 5; // Небольшой отступ справа

        for (const participant of Array.from(this.participants.values())) {
            const castle = participant.castle;
            if (!castle || castle.IsDead) continue;

            // --- Расчет сдвига по Y ---
            const yOffsetPerLine = 0.5;
            const baseOffsetY = -1.8;
            const targetMemberCount = this.getTargetTeamMemberCount(participant);
            const totalInfoBlockLines = 1 + (targetMemberCount > 0 ? 1 + targetMemberCount : 0);
            const additionalLines = totalInfoBlockLines - 1;
            const finalOffsetY = baseOffsetY - (additionalLines * yOffsetPerLine);
            const topY = Math.floor(32 * (castle.Cell.Y + finalOffsetY));

            let yShift = 0;
            if (topY < 0) {
                yShift = -topY + topMargin; // Сдвигаем блок вниз
            }

            // --- Расчет сдвига по X ---
            const x = 32 * (castle.Cell.X - 1);
            const estimatedCharWidth = 11; // Приблизительная ширина символа для шрифта высотой 22
            let longestLineLength = 0;

            // Находим самую длинную строку в блоке для оценки ширины
            const resourceReward = Math.floor(this.settings.powerPointsRewardPercentage * participant.powerPoints);
            const peopleReward = Math.floor(0.02 * this.settings.powerPointsRewardPercentage * participant.powerPoints);
            const ppText = `Сила: ${Math.round(participant.powerPoints)} (+${resourceReward} рес., +${peopleReward} чел.)`;
            longestLineLength = ppText.length;

            if (this.settings.enableTargetSystem) {
                const target = participant.target;
                const targetTeam = target ? this.teams.get(target.teamId) : null;
                const targetMembers = targetTeam ? targetTeam.getMembers() : [];
                if (targetMembers.length > 0) {
                    if ("Цель:".length > longestLineLength) {
                        longestLineLength = "Цель:".length;
                    }
                    for (const member of targetMembers) {
                        if (member.name.length > longestLineLength) {
                            longestLineLength = member.name.length;
                        }
                    }
                }
            }
            
            const estimatedWidth = longestLineLength * estimatedCharWidth;
            let xShift = 0;
            const rightEdge = x + estimatedWidth;
            if (rightEdge > sceneWidthPx) {
                xShift = sceneWidthPx - rightEdge - rightMargin; // Сдвигаем блок влево
            }
            
            // --- Конец расчетов ---

            this.updatePowerPointsDecorator(participant, sceneWidthPx, sceneHeightPx, yShift, xShift);
            this.updateStatusDecorator(participant, sceneWidthPx, sceneHeightPx);
            this.updateTargetDecorator(participant, sceneWidthPx, sceneHeightPx, yShift, xShift);
            this.updateCastleFrame(participant);
        }
    }

    private updatePowerPointsDecorator(participant: FfaParticipant, sceneWidthPx: number, sceneHeightPx: number, yShift: number, xShift: number): void {
        const decorator = this.powerPointDecorators.get(participant.id);
        if (decorator) {
            const yOffsetPerLine = 0.5;
            const baseOffsetY = -1.8;

            const targetMemberCount = this.getTargetTeamMemberCount(participant);
            const totalInfoBlockLines = 1 + (targetMemberCount > 0 ? 1 + targetMemberCount : 0);
            
            const additionalLines = totalInfoBlockLines - 1;
            const finalOffsetY = baseOffsetY - (additionalLines * yOffsetPerLine);

            const resourceReward = Math.floor(this.settings.powerPointsRewardPercentage * participant.powerPoints);
            const peopleReward = Math.floor(0.02 * this.settings.powerPointsRewardPercentage * participant.powerPoints);
            const text = `Сила: ${Math.round(participant.powerPoints)} (+${resourceReward} рес., +${peopleReward} чел.)`;
            
            const x = 32 * (participant.castle.Cell.X - 1) + xShift;
            const y = Math.floor(32 * (participant.castle.Cell.Y + finalOffsetY)) + yShift;

            if (x < 0 || y > sceneHeightPx) { // Проверяем только левую и нижнюю границы
                if (decorator.Text !== "") {
                    decorator.Text = "";
                }
            } else {
                decorator.Text = text;
                decorator.Position = createPoint(x, y);
            }
        }
    }

    private updateStatusDecorator(participant: FfaParticipant, sceneWidthPx: number, sceneHeightPx: number): void {
        const decorator = this.statusDecorators.get(participant.id);
        if (decorator) {
            let statusText = participant.isSuzerain() ? "Сюзерен" : "Вассал";
            if (this.bountyParticipant && participant.id === this.bountyParticipant.id) {
                statusText += " (ГЛАВНАЯ ЦЕЛЬ)";
            }
            
            const x = Math.floor(32 * (participant.castle.Cell.X + 2.7));
            const y = Math.floor(32 * (participant.castle.Cell.Y + 3.6));

            if (y < 0 || x < 0 || x > sceneWidthPx || y > sceneHeightPx) {
                if (decorator.Text !== "") {
                    decorator.Text = "";
                }
            } else {
                decorator.Text = statusText;
                decorator.Position = createPoint(x, y);
            }
        }
    }

    private updateTargetDecorator(participant: FfaParticipant, sceneWidthPx: number, sceneHeightPx: number, yShift: number, xShift: number): void {
        if (!this.settings.enableTargetSystem) {
            return;
        }
        const decorators = this.targetDecorators.get(participant.id);
        if (!decorators) {
            this.log.warning(`[${participant.name}] Декораторы цели не найдены.`);
            return;
        }
    
        const target = participant.target;
        const targetTeam = target ? this.teams.get(target.teamId) : null;
        const targetMembers = targetTeam ? targetTeam.getMembers() : [];
        this.log.info(`[${participant.name}] Обновление декоратора цели. Цель: ${target?.name ?? 'нет'}. Команда цели: ${targetTeam?.suzerain.name ?? 'нет'}. Участников в команде цели: ${targetMembers.length}.`);
    
        // --- Расчет позиций ---
        const yOffsetPerLine = 0.5;
        const baseOffsetY = -1.8;
    
        const targetMemberCount = targetMembers.length;
        const totalInfoBlockLines = 1 + (targetMemberCount > 0 ? 1 + targetMemberCount : 0);
        const additionalLines = totalInfoBlockLines - 1;
        
        const powerPointsOffsetY = baseOffsetY - (additionalLines * yOffsetPerLine);
        const titleOffsetY = powerPointsOffsetY + yOffsetPerLine;
        
        const castleXCell = participant.castle.Cell.X - 1;
        const castleYCell = participant.castle.Cell.Y;
        this.log.info(`[${participant.name}] Расчет позиций: totalInfoBlockLines=${totalInfoBlockLines}, titleOffsetY=${titleOffsetY.toFixed(2)}, yShift=${yShift}, xShift=${xShift}`);
    
        // --- Обновление декораторов ---
        const maxDecorators = decorators.length;
    
        // 1. Обновляем декоратор заголовка "Цель:"
        const titleDecorator = decorators[0];
        if (targetMembers.length > 0) {
            const x = Math.floor(32 * castleXCell) + xShift;
            const y = Math.floor(32 * (castleYCell + titleOffsetY)) + yShift;
            const isVisible = x >= 0 && y >= 0 && y <= sceneHeightPx;

            if (isVisible) {
                titleDecorator.Text = "Цель:";
                const ppDecorator = this.powerPointDecorators.get(participant.id);
                if (ppDecorator) {
                    titleDecorator.Color = ppDecorator.Color;
                }
                titleDecorator.Position = createPoint(x, y);
            } else {
                if (titleDecorator.Text !== "") titleDecorator.Text = "";
            }
        } else {
            if (titleDecorator.Text !== "") titleDecorator.Text = "";
        }
    
        // 2. Обновляем декораторы для членов команды-цели
        for (let i = 0; i < maxDecorators - 1; i++) {
            const memberDecorator = decorators[i + 1];
            if (i < targetMembers.length) {
                const member = targetMembers[i];
                const memberOffsetY = titleOffsetY + ((i + 1) * yOffsetPerLine);
                const x = Math.floor(32 * castleXCell) + xShift;
                const y = Math.floor(32 * (castleYCell + memberOffsetY)) + yShift;
                const isVisible = x >= 0 && y >= 0 && y <= sceneHeightPx;

                if (isVisible) {
                    memberDecorator.Text = member.name;
                    memberDecorator.Color = member.settlement.SettlementColor;
                    memberDecorator.Position = createPoint(x, y);
                } else {
                    if (memberDecorator.Text !== "") memberDecorator.Text = "";
                }
            } else {
                if (memberDecorator.Text !== "") memberDecorator.Text = "";
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
        ppDecorator.FogOfWarMode = HordeClassLibrary.World.Objects.VisualEffects.VisualEffectFogOfWarMode.Ignore;
        ppDecorator.Height = 22;
        ppDecorator.Color = textColor;
        ppDecorator.DrawLayer = DrawLayer.Birds;
        //@ts-ignore
        ppDecorator.Font = FontUtils.DefaultVectorFont;
        this.powerPointDecorators.set(participant.id, ppDecorator);

        const statusDecorator = spawnString(ActiveScena, participant.isSuzerain() ? "Сюзерен" : "Вассал", createPoint(0, 0), 10 * 60 * 60 * 50);
        statusDecorator.FogOfWarMode = HordeClassLibrary.World.Objects.VisualEffects.VisualEffectFogOfWarMode.Ignore;
        statusDecorator.Height = 22;
        statusDecorator.Color = textColor;
        statusDecorator.DrawLayer = DrawLayer.Birds;
        //@ts-ignore
        statusDecorator.Font = FontUtils.DefaultVectorFont;
        this.statusDecorators.set(participant.id, statusDecorator);

        if (this.settings.enableTargetSystem) {
            const decorators: StringVisualEffect[] = [];
            // Максимальное количество отображаемых целей. 1 для заголовка + 16 для игроков.
            const maxTargets = 17;
            for (let i = 0; i < maxTargets; i++) {
                const targetDecorator = spawnString(ActiveScena, "", createPoint(0, 0), 10 * 60 * 60 * 50);
                targetDecorator.FogOfWarMode = HordeClassLibrary.World.Objects.VisualEffects.VisualEffectFogOfWarMode.Ignore;
                targetDecorator.Height = 22;
                targetDecorator.DrawLayer = DrawLayer.Birds;
                //@ts-ignore
                targetDecorator.Font = FontUtils.DefaultVectorFont;
                decorators.push(targetDecorator);
            }
            this.targetDecorators.set(participant.id, decorators);
        }

        const frame = this.createCastleFrame(participant);
        frame.FogOfWarMode = HordeClassLibrary.World.Objects.VisualEffects.VisualEffectFogOfWarMode.Ignore;
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
            if (this.settings.isChallengeSystemEnabled) {
                message += "\t- Вызов системе: Игроки с никами 'князъ' или 'повелитель' объединяются против всех остальных.\n";
            }
            if (this.settings.enableTargetSystem) {
                message += "\t- Цели: Командам назначаются симметричные цели. Атакуйте назначенную команду для получения бонусных очков.\n";
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
            if (this.settings.enablePowerPointsExchange) {
                message += "\t- Обмен очками: Сюзерены и вассалы обмениваются очками силы при передаче ресурсов.\n";
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
