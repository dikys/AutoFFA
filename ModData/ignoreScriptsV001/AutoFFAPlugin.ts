import HordePluginBase from "plugins/base-plugin";
import { log, LogLevel } from "library/common/logging";
import { broadcastMessage, createGameMessageWithNoSound, createGameMessageWithSound } from "library/common/messages";
import { createHordeColor, createPoint } from "library/common/primitives";
import { DiplomacyStatus, DrawLayer, FontUtils, GeometryCanvas, GeometryVisualEffect, Stride_Color, Stride_Vector2, StringVisualEffect, Unit } from "library/game-logic/horde-types";
import { isReplayMode } from "library/game-logic/game-tools";
import { spawnGeometry, spawnString } from "library/game-logic/decoration-spawn";
import { FfaParticipant } from "./FfaParticipant";
import { Team } from "./Team";

function distance_Chebyshev(x1: number, y1: number, x2: number, y2: number) {
    return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

export class AutoFfaPlugin extends HordePluginBase {
    private participants: Map<number, FfaParticipant> = new Map();
    private teams: Map<number, Team> = new Map();
    private settlementUidToParticipantId: Map<string, number> = new Map();
    private unitCfgUidToPowerPerHp: Map<string, number> = new Map();

    private powerPointDecorators: Map<number, StringVisualEffect> = new Map();
    private statusDecorators: Map<number, StringVisualEffect> = new Map();
    private castleFrames: Map<number, GeometryVisualEffect> = new Map();

    private isGameFinished = false;
    private gameCyclePeriod = 100;
    private truceTime = 5 * 60 * 50;
    private suzerainPowerPointsTakenPercentage = 0.20;
    private vassalPowerPointsTakenPercentage = 0.10;

    constructor() {
        super("Auto FFA (OOP)");
        this.log.logLevel = LogLevel.Info;
    }

    // Именованные константы для смещений в игровом цикле
    private readonly TICK_OFFSET_TRIBUTES = 11;
    private readonly TICK_OFFSET_GENEROSITY = 22;
    private readonly TICK_OFFSET_MIGRATIONS = 33;
    private readonly TICK_OFFSET_WARS = 44;
    private readonly TICK_OFFSET_DECORATORS = 55;
    private readonly TICK_OFFSET_PROMOTIONS = 66;
    private readonly TICK_OFFSET_REWARDS = 77;
    private readonly TICK_OFFSET_DEFEATS = 88;
    private readonly TICK_OFFSET_GAME_END_CHECK = 99;

    public onFirstRun() {
        broadcastMessage("Добро пожаловать в auto FFA!\nСтань единственным сюзереном этих земель!\nОбъявлен всеобщий временный мир.", createHordeColor(255, 255, 140, 140));
    }

    public onEveryTick(gameTickNum: number) {
        if (this.isGameFinished) return;

        if (gameTickNum === 1) {
            this.initialize();
            return;
        }

        // Отображение сообщений с правилами в начале игры (больше не блокирует основной цикл)
        this.displayInitialMessages(gameTickNum);

        // Определяем, активен ли еще период перемирия. Основные "боевые" действия заблокированы в этот период.
        const isTrucePeriodActive = gameTickNum < 50 * 100;

        // Основной игровой цикл
        switch (gameTickNum % this.gameCyclePeriod) {
            case this.TICK_OFFSET_TRIBUTES:
                if (!isTrucePeriodActive) this.processVassalTributes();
                break;
            case this.TICK_OFFSET_GENEROSITY:
                if (!isTrucePeriodActive) this.processSuzerainGenerosity();
                break;
            case this.TICK_OFFSET_MIGRATIONS:
                if (!isTrucePeriodActive) this.processTeamMigrations(gameTickNum);
                break;
            case this.TICK_OFFSET_WARS:
                if (!isTrucePeriodActive) this.findAndDeclareWars(gameTickNum);
                break;
            case this.TICK_OFFSET_DECORATORS: this.updateDecorators(); break;
            case this.TICK_OFFSET_PROMOTIONS: this.promoteNewSuzerains(); break;
            case this.TICK_OFFSET_REWARDS: this.processPowerPointRewards(gameTickNum); break;
            case this.TICK_OFFSET_DEFEATS: this.checkForDefeatedParticipants(); break;
            case this.TICK_OFFSET_GAME_END_CHECK: this.checkForGameEnd(); break;
        }
    }

    private initialize(): void {
        this.log.info("Initializing Auto FFA...");

        // 1. Найти всех активных игроков и создать для них FfaParticipant
        const sceneSettlements = ActiveScena.GetRealScena().Settlements;
        const playerSettlementUids = new Set<string>();
        for (const player of Players) {
            const realPlayer = player.GetRealPlayer();
            if (isReplayMode() && !realPlayer.IsReplay) continue;
            playerSettlementUids.add(realPlayer.GetRealSettlement().Uid);
        }

        let participantIdCounter = 0;
        for (const uid of Array.from(playerSettlementUids).sort()) {
            const settlement = sceneSettlements.Item.get(uid);
            const castle = settlement.Units.GetCastleOrAnyUnit();

            if (!castle || !castle.Cfg.HasMainBuildingSpecification) {
                this.log.warning(`Settlement ${uid} has no castle and will be ignored.`);
                continue;
            }
            
            const name = settlement.LeaderName; //Players.GetPlayerByUid(uid)?.GetRealPlayer()?.Nickname ?? `Settlement ${uid}`;
            const participant = new FfaParticipant(participantIdCounter, settlement, name, castle);
            
            this.participants.set(participant.id, participant);
            this.settlementUidToParticipantId.set(uid, participant.id);
            
            // 2. Создать команду для каждого участника
            const team = new Team(participant.id, participant);
            this.teams.set(team.id, team);

            // 3. Настроить визуальные декораторы
            this.createDecoratorsForParticipant(participant);

            // 4. Включить кастомные условия победы/поражения
            const existenceRule = settlement.RulesOverseer.GetExistenceRule();
            const principalInstruction = ScriptUtils.GetValue(existenceRule, "PrincipalInstruction");
            ScriptUtils.SetValue(principalInstruction, "AlmostDefeatCondition", HordeClassLibrary.World.Settlements.Existence.AlmostDefeatCondition.Custom);
            ScriptUtils.SetValue(principalInstruction, "TotalDefeatCondition", HordeClassLibrary.World.Settlements.Existence.TotalDefeatCondition.Custom);
            ScriptUtils.SetValue(principalInstruction, "VictoryCondition", HordeClassLibrary.World.Settlements.Existence.VictoryCondition.Custom);

            participantIdCounter++;
        }

        // Обновляем позицию всех декораторов один раз после их полного создания
        this.updateDecorators();

        const allParticipants = Array.from(this.participants.values());

        // 5. Установить мир между всеми
        for (const p1 of allParticipants) {
            for (const p2 of allParticipants) {
                if (p1.id !== p2.id) {
                    p1.settlement.Diplomacy.DeclarePeace(p2.settlement);
                }
            }
        }

        // 6. Подписаться на событие нанесения урона
        for (const participant of allParticipants) {
            participant.settlement.Units.UnitCauseDamage.connect(this.onUnitCauseDamage.bind(this));
        }

        this.log.info(`Initialization complete. Found ${this.participants.size} participants.`);
    }

    private onUnitCauseDamage(sender: any, args: any): void {
        const attackerOwnerUid = args.TriggeredUnit.Owner.Uid;
        const victimOwnerUid = args.VictimUnit.Owner.Uid;

        const attackerId = this.settlementUidToParticipantId.get(attackerOwnerUid);
        const victimId = this.settlementUidToParticipantId.get(victimOwnerUid);

        if (attackerId === undefined || victimId === undefined || attackerId === victimId) return;

        const attacker = this.participants.get(attackerId);
        const victim = this.participants.get(victimId);
        if (!attacker || !victim) return;

        const diplomacy = attacker.settlement.Diplomacy.GetDiplomacyStatus(victim.settlement);

        if (diplomacy === DiplomacyStatus.War) {
            let powerPointPerHp = this.unitCfgUidToPowerPerHp.get(args.VictimUnit.Cfg.Uid);
            if (powerPointPerHp === undefined) {
                const cfg = args.VictimUnit.Cfg;
                powerPointPerHp = 0.01 * (cfg.CostResources.Gold + cfg.CostResources.Metal + cfg.CostResources.Lumber + 50 * cfg.CostResources.People) / cfg.MaxHealth;
                this.unitCfgUidToPowerPerHp.set(args.VictimUnit.Cfg.Uid, powerPointPerHp);
            }

            const distanceFactor = Math.log(Math.max(1, distance_Chebyshev(
                attacker.castle.Cell.X, attacker.castle.Cell.Y,
                args.TriggeredUnit.Cell.X, args.TriggeredUnit.Cell.Y
            )));
            
            const deltaPoints = args.Damage * powerPointPerHp * distanceFactor;
            attacker.powerPoints += deltaPoints;
            attacker.damageDealtTo.set(victim.id, (attacker.damageDealtTo.get(victim.id) || 0) + deltaPoints);
        } else if (diplomacy === DiplomacyStatus.Neutral) {
            // Возвращаем урон мирным юнитам
            if (args.VictimUnit.Health < args.VictimUnit.Cfg.MaxHealth) {
                 args.VictimUnit.Health += Math.min(args.VictimUnit.Cfg.MaxHealth - args.VictimUnit.Health, args.Damage);
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
            participant.isDefeated = participant.castle.IsDead;
        }
    }

    private processTeamMigrations(gameTickNum: number): void {
        const defeatedParticipants = Array.from(this.participants.values()).filter(p => p.isDefeated);

        for (const defeated of defeatedParticipants) {
            const loserTeam = this.teams.get(defeated.teamId);
            if (!loserTeam || !loserTeam.enemyTeam) continue;

            const winnerTeam = loserTeam.enemyTeam;
            this.log.info(`Participant ${defeated.name} (${defeated.id}) is defeated. Migrating from team ${loserTeam.id} to ${winnerTeam.id}.`);

            if (defeated.isSuzerain()) {
                // Сюзерен проиграл, вся его команда переходит к победителю
                const formerVassals = loserTeam.vassals;
                const allLosers = loserTeam.getMembers();

                for (const member of allLosers) {
                    const takenPercentage = member.isSuzerain() ? this.suzerainPowerPointsTakenPercentage : this.vassalPowerPointsTakenPercentage;
                    winnerTeam.shareSpoils(member, takenPercentage);
                }

                winnerTeam.addSuzerainAndVassals(defeated, formerVassals);
                this.teams.delete(loserTeam.id);

                broadcastMessage(`Сюзерен ${winnerTeam.suzerain.name} одержал великую победу! Команда ${defeated.name} присоединилась к нему.`, winnerTeam.suzerain.settlement.SettlementColor);

            } else {
                // Вассал проиграл, он один переходит к победителю
                broadcastMessage(`Вассал ${defeated.name} перешел на сторону ${winnerTeam.suzerain.name}!`, winnerTeam.suzerain.settlement.SettlementColor);
                winnerTeam.shareSpoils(defeated, this.vassalPowerPointsTakenPercentage);
                loserTeam.removeVassal(defeated);
                winnerTeam.addVassal(defeated);
            }

            // После миграции команда-победитель заключает мир
            winnerTeam.makePeace();
            winnerTeam.lastVictoryTick = gameTickNum;
            winnerTeam.truceNotificationState = 0;
            defeated.isDefeated = false; // Сбрасываем флаг после обработки
        }
    }

    private findAndDeclareWars(gameTickNum: number): void {
        const freeTeams = Array.from(this.teams.values()).filter(t => t.enemyTeam === null);
        const rnd = ActiveScena.GetRealScena().Context.Randomizer;

        // Логика для команд, которые долго бездействуют
        if (freeTeams.length === 1) {
            const loneTeam = freeTeams[0];
            if (loneTeam.lastVictoryTick > 0 && gameTickNum > loneTeam.lastVictoryTick + this.truceTime) {
                this.log.info(`Team ${loneTeam.id} is idle for too long. Forcing migration.`);
                const otherTeams = Array.from(this.teams.values()).filter(t => t.id !== loneTeam.id);
                if (otherTeams.length > 0) {
                    // Присоединяемся к самой слабой воюющей команде
                    otherTeams.sort((a, b) => a.getPower() - b.getPower());
                    const weakestTeam = otherTeams[0];
                    
                    broadcastMessage(`Сюзерен ${loneTeam.suzerain.name} не желает сидеть без дела и вступает в битву на стороне ${weakestTeam.suzerain.name}!`, loneTeam.suzerain.settlement.SettlementColor);

                    const loneTeamMembers = loneTeam.getMembers();
                    for(const member of loneTeamMembers) {
                        // В этом случае очки не отнимаются, а просто происходит присоединение
                        weakestTeam.addVassal(member);
                    }
                    this.teams.delete(loneTeam.id);
                }
            }
            return;
        }

        // Спарриваем свободные команды для войны
        while (freeTeams.length > 1) {
            const team1Index = rnd.RandomNumber(0, freeTeams.length - 1);
            const [team1] = freeTeams.splice(team1Index, 1);

            const team2Index = rnd.RandomNumber(0, freeTeams.length - 1);
            const [team2] = freeTeams.splice(team2Index, 1);

            team1.declareWarOn(team2);
            this.log.info(`War declared between Team ${team1.id} and Team ${team2.id}`);

            const message = `Между сюзереном ${team1.suzerain.name} (${team1.vassals.length} вассалов) и сюзереном ${team2.suzerain.name} (${team2.vassals.length} вассалов) объявлена война!`;
            broadcastMessage(message, createHordeColor(255, 255, 140, 140));
        }
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

            broadcastMessage(`Единственным правителем земель стал ${winnerName}!`, winnerTeam.suzerain.settlement.SettlementColor);

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
        this.log.info(`updateDecorators`);
        for (const participant of Array.from(this.participants.values())) {
            const castle = participant.castle;
            if (!castle || castle.IsDead) continue;

            this.log.info(`Updating decorators for ${participant.name}: Power=${Math.round(participant.powerPoints)}, Status='${participant.isSuzerain() ? "Сюзерен" : "Вассал"}'`);

            // Обновление текста очков власти
            const ppDecorator = this.powerPointDecorators.get(participant.id);
            if (ppDecorator) {
                this.log.info(`Updating power points decorator for ${participant.name}`);
                ppDecorator.Text = `Очки власти: ${Math.round(participant.powerPoints)}`;
                ppDecorator.Position = createPoint(32 * (castle.Cell.X - 1), Math.floor(32 * (castle.Cell.Y - 1.3)));
            }

            // Обновление текста статуса
            const statusDecorator = this.statusDecorators.get(participant.id);
            if (statusDecorator) {
                this.log.info(`Updating status decorator for ${participant.name}`);
                statusDecorator.Text = participant.isSuzerain() ? "Сюзерен" : "Вассал";
                statusDecorator.Position = createPoint(Math.floor(32 * (castle.Cell.X + 2.7)), Math.floor(32 * (castle.Cell.Y + 3.6)));
            }

            // Обновление позиции рамки
            const frame = this.castleFrames.get(participant.id);
            if (frame) {
                frame.Position = castle.Position;
            }
        }
    }

    private createDecoratorsForParticipant(participant: FfaParticipant): void {
        const settlementColor = participant.settlement.SettlementColor;
        const textColor = createHordeColor(255, Math.min(255, settlementColor.R + 128), Math.min(255, settlementColor.G + 128), Math.min(255, settlementColor.B + 128));

        // Декоратор для очков власти
        const ppDecorator = spawnString(ActiveScena, `Очки власти: ${Math.round(participant.powerPoints)}`, createPoint(0, 0), 10*60*60*50);
        ppDecorator.Height = 22;
        ppDecorator.Color = textColor;
        ppDecorator.DrawLayer = DrawLayer.Birds;
        //@ts-ignore
        ppDecorator.Font = FontUtils.DefaultVectorFont;
        this.powerPointDecorators.set(participant.id, ppDecorator);

        // Декоратор для статуса
        const statusDecorator = spawnString(ActiveScena, participant.isSuzerain() ? "Сюзерен" : "Вассал", createPoint(0, 0), 10*60*60*50);
        statusDecorator.Height = 22;
        statusDecorator.Color = textColor;
        statusDecorator.DrawLayer = DrawLayer.Birds;
        //@ts-ignore
        statusDecorator.Font = FontUtils.DefaultVectorFont;
        this.statusDecorators.set(participant.id, statusDecorator);

        // Рамка вокруг замка
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

        return spawnGeometry(ActiveScena, geometryCanvas.GetBuffers(), participant.castle.Position, 10*60*60*50);
    }

    private displayInitialMessages(gameTickNum: number) {
        const color = createHordeColor(255, 255, 140, 140);
        let message = "";

        if (gameTickNum === 50 * 10) {
            message = "Правила игры:\n" +
                      "\t1. Войны идут дуэлями\n" +
                      "\t2. Победил остался сюзереном\n";
        } else if (gameTickNum === 50 * 30) {
            message = `\t3. Проиграл (потерял главный замок) стал вассалом\n` +
                      `\t4. Вассал отдает ресы (>${FfaParticipant.VASSAL_RESOURCE_LIMIT} + 10% очков власти) своему сюзерену\n` +
                      `\t5. Вассал имеет лимит людей (${FfaParticipant.VASSAL_POPULATION_LIMIT} + 0.2% очков власти)\n`;
        } else if (gameTickNum === 50 * 50) {
            message = `\t6. Вассал проиграл, то на чужую сторону перешел\n` +
                      `\t7. После ${this.truceTime / (60 * 50)} минут, сюзерен без врага присоединяется к слабейшей команде\n` +
                      `\t8. Сюзерен щедрый (делится с вассалами) если ресурса > ${Team.SUZERAIN_GENEROSITY_THRESHOLD}\n`;
        } else if (gameTickNum === 50 * 70) {
            message = `\t9. Сюзерен тот у кого больше очков власти (прибавляются за победы, сражения, отнимаются за поражения, помощь)\n` +
                      `\t10. После налогов и зарплат идет начисление ресурсов ${Math.round(FfaParticipant.POWER_POINTS_REWARD_PERCENTAGE * 100)} % от очков власти\n` +
                      `\t11. Урон мирным не наносится\n`;
        } else if (gameTickNum === 50 * 90) {
            message = "Правила оглашены, время для битвы настало!";
        }

        if (message) {
            broadcastMessage(message, color);
        }
    }
}