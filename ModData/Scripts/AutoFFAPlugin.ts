import { log, LogLevel } from "library/common/logging";
import { broadcastMessage, createGameMessageWithNoSound, createGameMessageWithSound } from "library/common/messages";
import { generateCellInSpiral } from "library/common/position-tools";
import { createHordeColor, createPoint, createResourcesAmount, Point2D } from "library/common/primitives";
import { DiplomacyStatus, UnitDirection, DrawLayer, FontUtils, GeometryVisualEffect, GeometryCanvas, Stride_Vector2, Stride_Color, UnitCommand, Settlement, UnitConfig, Unit, StringVisualEffect } from "library/game-logic/horde-types";
import { unitCanBePlacedByRealMap } from "library/game-logic/unit-and-map";
import HordePluginBase from "plugins/base-plugin";
import { isReplayMode } from "library/game-logic/game-tools";
import { spawnGeometry, spawnString } from "library/game-logic/decoration-spawn";

const SpawnUnitParameters = HordeClassLibrary.World.Objects.Units.SpawnUnitParameters;

// 20241129
// начальное число очков власти 0 -> 1500
// в 2 раза уменьшил набор очков за урон
// теперь урон не наносится только нейтралам (ранее союзникам тоже)
// добавлено сообщение сколько начислено очков власти за победу
// изменено сообщение об объявлении войны между сюзеренами
// добавлена подпись сюзерен и вассал

// 20241121
// теперь дерева 5% -> 10% от очков власти начисляют
// начальное число очков власти = 0
// в 4 раза увеличил набор очков за урон

// 20241118
// теперь дерева 5% от очков власти начисляют
// изменил цвет текста очков власти, теперь ближе к цвету игрока
// теперь мирным целям нельзя нанести существенный урон

// 20241116
// Убрал надпись у проигравшего вассала "Ваш вассал перешел *****"
// Добавил очки власти за нанесение урона
// Переработал начисление очков власти при поражении/победе, теперь 20/10% очков проигравшего сюзерена/вассала разделяются среди команды относительно нанесенного урона
// Теперь если тебя взяли под крыло по терпимости, то тоже 20/10% очков забирают у сюзерена/вассала по равну среди команды

// 20241109
// Первый таймер терпимости теперь с объявления войны, а не с начала игры
// Добавил запрет на самоуничтожение главного замка
// Добавил очки власти (пока считаются просто за победу/поражение). Если проиграл вассал, то сюзеренам +300 и -500, вассалам +250, -300. Если проиграл сюзерен, то сюзеренам +1000 и -1000, вассалам +500 и -500.
// Также добавил автоматическую сменю сюзерена на того у кого больше всего очков власти.

// class Queue<T> {
//     public constructor(
//         private elements: Record<number, T> = {},
//         private head: number = 0,
//         private tail: number = 0
//     ) { }
//     public enqueue(element: T): void {
//         this.elements[this.tail] = element;
//         this.tail++;
//     }
//     public dequeue(): T {
//         const item = this.elements[this.head];
//         delete this.elements[this.head];
//         this.head++;

//         return item;
//     }
//     public peek(): T {
//         return this.elements[this.head];
//     }
//     public get length(): number {
//         return this.tail - this.head;
//     }
//     public get isEmpty(): boolean {
//         return this.length === 0;
//     }
// }

// class GameField {
//     /** номера команд в ячейках, -1 - команды нет */
//     public field_teamNum : Array<Array<number>>;
//     /** (будующие) номера команд в ячейках, -1 - команды нет */
//     private _nextField_teamNum : Array<Array<number>>;
//     private _fillingStage: number;
//     private _fillingSettlementNum: number;
//     private _queue : Queue<Cell>;

//     constructor() {
//         let scenaWidth  = ActiveScena.GetRealScena().Size.Width;
//         let scenaHeight = ActiveScena.GetRealScena().Size.Height;

//         this.field_teamNum = new Array<Array<number>>();
//         this._nextField_teamNum = new Array<Array<number>>();
//         for (var i = 0; i < scenaHeight; i++) {
//             this.field_teamNum.push(new Array<number>());
//             this._nextField_teamNum.push(new Array<number>());
//             for (var j = 0; j < scenaWidth; j++) {
//                 this.field_teamNum[i].push(-1);
//                 this._nextField_teamNum[i].push(-1);
//             }
//         }

//         this._fillingStage = 0;
//         this._queue = new Queue<Cell>();
//         this._fillingSettlementNum = 0;
//     }

//     public OnEveryTick(gameTickNum: number) {
//         if (this._fillingStage == 0) {
//         } else if (this._fillingStage == 1) {
//         } else if (this._fillingStage == 2) {
//         }
//     }
// }

function distance_Chebyshev (x1:number, y1:number, x2:number, y2:number) {
    return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

export class AutoFFAPlugin extends HordePluginBase {
    /** поселения */
    _settlements: Array<Settlement>;
    /** текущие команды в игре, -1 это вне игры */
    _settlements_teamNum : Array<number>;
    /** перевод settlementUid в settlementNum */
    _opSettlementUidToSettlementNum : Array<number>;
    /** таблица мира */
    _settlements_settlements_diplomacyStatus : Array<Array<DiplomacyStatus>>;

    /** ид поселения-сюзерена, -1 значит нету */
    _settlements_suzerainNum : Array<number>;
    /** лимит популяция у вассалов */
    _vassal_limitPeople : number = 60;
    /** лимит ресурсов у вассалов */
    _vassal_limitResources : number = 1000;
    /** число ресурсов сюзерена после которого он щедрится */
    _suzerain_generosityThreshold : number = 5000;

    /** конфиг замка у поселений */
    _settlements_castleCfg : Array<UnitConfig>;
    /** главный замок поселения */
    _settlements_castle: Array<Unit>;
    /** рамка вокруг главного замка */
    _settlements_castleFrame: Array<GeometryVisualEffect>;

    /** флаг, что поселение проиграло */
    _settlements_isDefeat : Array<boolean>;

    /** имена поселений */
    _settlements_name : Array<string>;

    /** время победы противника у команд */
    _teams_lastVictoryGameTickNum : Array<number>;
    /** номер оповещения остальных врагов */
    _teams_truceNotificationNumber : Array<number>;
    /** время перемирия */
    _team_truceTime : number = 5 * 60 * 50;

    /** флаг, что игра закончилась */
    _endGame : boolean = false;

    /** период для повторого игрового цикла */
    _gameCyclePeriod : number = 100;

    /** очки власти */
    _settlements_powerPoints : Array<number>;
    /** строка-декоратор для отображения очков */
    _settlements_powerPointStrDecorators : Array<StringVisualEffect>;
    /** map uid - очки власти на единицу здоровья */
    _opCfgUidToPowerPointPerHp : Map<string, number>;
    /** таблица очков власти за атаку */
    _settlements_settlements_powerPoints : Array<Array<number>>;
    /** доля отнятие очков у сюзерена */
    _suzerain_powerPoints_takenPercentage : number = 0.20;
    /** доля отнятие очков у вассала */
    _vassal_powerPoints_takenPercentage : number = 0.10;

    /** базовая доля начисления за очки власти */
    _powerPoints_rewardPercentage : number = 0.10;
    /** время следующего начисления награды за очки власти */
    _settlements_nextRewardTime : Array<number>;

    /** строка-декоратор для отображения статуса игрока */
    _settlements_statusStrDecorators : Array<StringVisualEffect>;

    public constructor() {
        super("Auto FFA");

        this.log.logLevel = LogLevel.Debug;

        this._settlements                   = new Array<Settlement>();
        this._settlements_teamNum           = new Array<number>();
        this._teams_lastVictoryGameTickNum  = new Array<number>();
        this._teams_truceNotificationNumber = new Array<number>();
        this._opSettlementUidToSettlementNum = new Array<any>();
        this._settlements_suzerainNum = new Array<number>();
        this._settlements_statusStrDecorators = new Array<StringVisualEffect>();
        this._settlements_nextRewardTime = new Array<number>();
        this._settlements_settlements_powerPoints = new Array<Array<number>>();
        this._opCfgUidToPowerPointPerHp = new Map<string, number>();
        this._settlements_powerPoints = new Array<number>();
        this._settlements_powerPointStrDecorators = new Array<StringVisualEffect>();
        this._settlements_name = new Array<string>();
        this._settlements_isDefeat = new Array<boolean>();
        this._settlements_castleFrame = new Array<GeometryVisualEffect>();
        this._settlements_castleCfg = new Array<UnitConfig>();
        this._settlements_castle    = new Array<Unit>();
        this._settlements_settlements_diplomacyStatus = new Array<Array<DiplomacyStatus>>();
    }

    public onFirstRun() {
        var message =
        "Добро пожаловать в auto FFA!\n" +
        "Стань единственным сюзереном этих земель!\n" +
        "Объявлен всеобщий временный мир.";
        broadcastMessage(message, createHordeColor(255, 255, 140, 140));
    }

    public onEveryTick(gameTickNum: number) {
        var FPS = HordeResurrection.Engine.Logic.Battle.BattleController.GameTimer.CurrentFpsLimit;

        if (gameTickNum == 1) {
            this._Init();
        } else if (gameTickNum < 50 * 10) {
        } else if (gameTickNum == 50 * 10) {
            var message =
            "Правила игры:\n" +
            "\t1. Войны идут дуэлями\n" +
            "\t2. Победил остался сюзереном\n";
            broadcastMessage(message, createHordeColor(255, 255, 140, 140));
        } else if (gameTickNum < 50 * 30) {
        } else if (gameTickNum == 50 * 30) {
            var message =
            "\t3. Проиграл (потерял главный замок) стал вассалом\n" +
            "\t4. Вассал отдает ресы (>" + this._vassal_limitResources + " + 10% очков власти) своему сюзерену\n" +
            "\t5. Вассал имеет лимит людей (" + this._vassal_limitPeople + " + 0.2% очков власти)\n";
            broadcastMessage(message, createHordeColor(255, 255, 140, 140));
        } else if (gameTickNum < 50 * 50) {
        } else if (gameTickNum == 50 * 50) {
            var message =
            "\t6. Вассал проиграл, то на чужую сторону перешел\n" +
            "\t7. После " + (this._team_truceTime / (60*50)) + " минут, сюзерен без врага присоединяется к слабейшей команде\n" +
            "\t8. Сюзерен щедрый (делится с вассалами) если ресурса > " + this._suzerain_generosityThreshold + "\n";
            broadcastMessage(message, createHordeColor(255, 255, 140, 140));
        } else if (gameTickNum < 50 * 70) {
        } else if (gameTickNum == 50 * 70) {
            var message =
            "\t9. Сюзерен тот у кого больше очков власти (прибавляются за победы, сражения, отнимаются за поражения, помощь)\n" +
            "\t10. После налогов и зарплат идет начисление ресурсов " + Math.round(this._powerPoints_rewardPercentage * 100) + " % от очков власти\n" +
            "\t11. Урон мирным не наносится\n";
            broadcastMessage(message, createHordeColor(255, 255, 140, 140));
        } else if (gameTickNum < 50 * 90) {
        } else if (gameTickNum == 50 * 90) {
            var message =
            "Правила оглашены, время для битвы настало!\n";
            broadcastMessage(message, createHordeColor(255, 255, 140, 140));
        } else if (gameTickNum < 50 * 100) {
        } else if (!this._endGame) {
            var globalGameTickNum = gameTickNum;
            gameTickNum -= 50*100;

            if (gameTickNum % this._gameCyclePeriod == 11) {
                this._VassalTribute(gameTickNum);
            } else if (gameTickNum % this._gameCyclePeriod == 22) {
                this._SuzerainGenerosity(gameTickNum);
            } else if (gameTickNum % this._gameCyclePeriod == 33) {
                this._TeamMigration(gameTickNum);
            } else if (gameTickNum % this._gameCyclePeriod == 44) {
                this._ChoiseEnemyTeam(gameTickNum);
            } else if (gameTickNum % this._gameCyclePeriod == 55) {
                this._UpdatePowerPointStrDecorators(gameTickNum);
            } else if (gameTickNum % this._gameCyclePeriod == 66) {
                this._AutomaticChangeSuzerain(gameTickNum);
            } else if (gameTickNum % this._gameCyclePeriod == 77) {
                this._SettlementsReward(globalGameTickNum);
            } else if (gameTickNum % this._gameCyclePeriod == 88) {
                this._DeffeatCheck(gameTickNum);
            } else if (gameTickNum % this._gameCyclePeriod == 99) {
                this._EndGameCheck(gameTickNum);
            } else {

            }
        }
    }

    private _Init() {
        var scenaSettlements = ActiveScena.GetRealScena().Settlements;

        // поселения в игре

        var settlementsUid : Array<number> = new Array<number>();
        for (var player of Players) {
            var realPlayer   = player.GetRealPlayer();
            var settlement   = realPlayer.GetRealSettlement();

            if (isReplayMode() && !realPlayer.IsReplay) {
                continue;
            }
            if (settlementsUid.find((settlementUid) => { return (settlementUid == Number.parseInt(settlement.Uid)); })) {
                continue;
            }
            this.log.info("Замечен игрок поселения ", settlement.Uid);
            settlementsUid.push(Number.parseInt(settlement.Uid));
        }
        settlementsUid.sort();

        // поселения

        this._opSettlementUidToSettlementNum = new Array<any>(ActiveScena.GetRealScena().Settlements.Count).fill(-1);
        for (var settlementNum = 0; settlementNum < settlementsUid.length; settlementNum++) {
            var settlement = scenaSettlements.Item.get(settlementsUid[settlementNum] + '');

            let someCastle = settlement.Units.GetCastleOrAnyUnit();
            if (!someCastle || !someCastle.Cfg.HasMainBuildingSpecification) {
                this.log.info("У поселения нет замка, игнорим ", settlement.Uid);
                settlementsUid.splice(settlementNum--, 1);
                continue;
            }
            this.log.info("Добавляем поселение ", settlement.Uid);
            this._opSettlementUidToSettlementNum[Number.parseInt(settlement.Uid)] = this._settlements.length;
            this._settlements.push(settlement);
        }

        // объявляем мир между всеми

        this._settlements_settlements_diplomacyStatus.length = this._settlements.length;
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            this._settlements_settlements_diplomacyStatus[settlementNum] = new Array<DiplomacyStatus>(this._settlements.length);
            for (var otherSettlementNum = 0; otherSettlementNum < this._settlements.length; otherSettlementNum++) {
                if (settlementNum == otherSettlementNum) {
                    this._settlements_settlements_diplomacyStatus[settlementNum][otherSettlementNum] = DiplomacyStatus.Alliance;
                    continue;
                }

                this._settlements[settlementNum].Diplomacy.DeclarePeace(this._settlements[otherSettlementNum]);
                this._settlements[otherSettlementNum].Diplomacy.DeclarePeace(this._settlements[settlementNum]);
                this._settlements_settlements_diplomacyStatus[settlementNum][otherSettlementNum] = DiplomacyStatus.Neutral;
            }
        }

        // инициализируем команды

        for (var settlementNum = 0, teamNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            this._settlements_teamNum.push(teamNum++);
            this._teams_lastVictoryGameTickNum.push(0);
            this._teams_truceNotificationNumber.push(0);
        }

        // инициализируем сюзеренов

        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            this._settlements_suzerainNum.push(-1);
        }

        // инициализируем имена поселений

        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            this._settlements_name.push("");
        }
        for (var player of Players) {
            var realPlayer   = player.GetRealPlayer();
            var settlement   = realPlayer.GetRealSettlement();

            if (isReplayMode() && !realPlayer.IsReplay) {
                continue;
            }

            // ищем номер поселения
            var settlementNum : number = settlementsUid.findIndex((Uid) => { return Uid == Number.parseInt(settlement.Uid)});
            if (settlementNum == -1) {
                continue;
            }
            this._settlements_name[settlementNum] += (this._settlements_name[settlementNum].length == 0 ? "" : "|" ) + realPlayer.Nickname;
        }

        // инициализируем конфиги замков

        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            let someCastle = this._settlements[settlementNum].Units.GetCastleOrAnyUnit();
            if (!someCastle || !someCastle.Cfg.HasMainBuildingSpecification) {
                broadcastMessage("У поселения " + this._settlements_name[settlementNum] + " нет замка!", createHordeColor(255, 255, 0, 0));
                //this._settlements_castleCfg.push(null);
                //this._settlements_castle.push(null);

                // прерываем игру
                broadcastMessage("AutoFFA не поддерживает эту карту!", createHordeColor(255, 255, 0, 0));
                this._endGame = true;
                return;
            } else {
                this._settlements_castleCfg.push(someCastle.Cfg);
                this._settlements_castle.push(someCastle);
            }
        }

        // включаем кастомные условия поражения

        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            this._settlements_isDefeat.push(false);
            // включаем кастомные условия поражения
            var existenceRule        = this._settlements[settlementNum].RulesOverseer.GetExistenceRule();
            var principalInstruction = ScriptUtils.GetValue(existenceRule, "PrincipalInstruction");
            ScriptUtils.SetValue(principalInstruction, "AlmostDefeatCondition", HordeClassLibrary.World.Settlements.Existence.AlmostDefeatCondition.Custom);
            ScriptUtils.SetValue(principalInstruction, "TotalDefeatCondition", HordeClassLibrary.World.Settlements.Existence.TotalDefeatCondition.Custom);
            ScriptUtils.SetValue(principalInstruction, "VictoryCondition", HordeClassLibrary.World.Settlements.Existence.VictoryCondition.Custom);
        }

        // пишем правила игрокам

        var message =
            "Правила игры:\n" +
            "\t1. Войны идут дуэлями\n" +
            "\t2. Победил остался сюзереном\n" +
            "\t3. Проиграл (потерял главный замок) стал вассалом\n" +
            "\t4. Вассал отдает ресы (>" + this._vassal_limitResources + " + 10% очков власти) своему сюзерену\n" +
            "\t5. Вассал имеет лимит людей (" + this._vassal_limitPeople + " + 0.2% очков власти)\n" +
            "\t6. Вассал проиграл, то на чужую сторону перешел\n" +
            "\t7. После " + (this._team_truceTime / (60*50)) + " минут, сюзерен без врага присоединяется к слабейшей команде\n" +
            "\t8. Сюзерен щедрый (делится с вассалами) если ресурса > " + this._suzerain_generosityThreshold + "\n" +
            "\t9. Сюзерен тот у кого больше очков власти (прибавляются за победы, сражения, отнимаются за поражения, помощь)\n" +
            "\t10. После налогов и зарплат идет начисление ресурсов " + Math.round(this._powerPoints_rewardPercentage * 100) + " % от очков власти\n" +
            "\t11. Урон мирным не наносится\n";
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            var someCastle = this._settlements_castle[settlementNum];

            var strDecObj = spawnString(
                ActiveScena,
                message,
                createPoint(32*(someCastle.Cell.X + 5), 32*(someCastle.Cell.Y)),
                50*80);
            strDecObj.Height    = 20;
            strDecObj.Color     = createHordeColor(255, 255, 255, 255);
            strDecObj.DrawLayer = DrawLayer.Birds;
            strDecObj.Font      = FontUtils.DefaultFont;
        }

        // инициализируем рамки замков

        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            let position            = this._settlements_castle[settlementNum].Position;
            let ticksToLive         = GeometryVisualEffect.InfiniteTTL;
            this._settlements_castleFrame.push(spawnGeometry(ActiveScena, this._CreateCastleFrameBuffer(settlementNum), position, ticksToLive));
        }

        // инициализируем очки власти

        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            this._settlements_powerPoints.push(1500);

            var someCastle = this._settlements_castle[settlementNum];
            var strDecObj = spawnString(
                ActiveScena,
                "Очки власти: " + Math.round(this._settlements_powerPoints[settlementNum]),
                createPoint(0, 0),
                10*60*60*50); // 10 часов
            strDecObj.Height    = 22;
            // strDecObj.Color     = createHordeColor(255, 255, 255, 255)
            // this._settlements[settlementNum].SettlementColor;
            strDecObj.Color     = createHordeColor(
                255,
                Math.min(255, this._settlements[settlementNum].SettlementColor.R + 128),
                Math.min(255, this._settlements[settlementNum].SettlementColor.G + 128),
                Math.min(255, this._settlements[settlementNum].SettlementColor.B + 128)
            );
            strDecObj.DrawLayer = DrawLayer.Birds;
            strDecObj.Font      = FontUtils.DefaultVectorFont;

            this._settlements_powerPointStrDecorators.push(strDecObj);
        }

        // создаем строку статуса

        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            var someCastle = this._settlements_castle[settlementNum];
            var strDecObj = spawnString(
                ActiveScena,
                "сюзерен",
                createPoint(0, 0),
                10*60*60*50); // 10 часов
            strDecObj.Height    = 22;
            strDecObj.Color     = createHordeColor(
                255,
                Math.min(255, this._settlements[settlementNum].SettlementColor.R + 128),
                Math.min(255, this._settlements[settlementNum].SettlementColor.G + 128),
                Math.min(255, this._settlements[settlementNum].SettlementColor.B + 128)
            );
            strDecObj.DrawLayer = DrawLayer.Birds;
            strDecObj.Font      = FontUtils.DefaultVectorFont;

            this._settlements_statusStrDecorators.push(strDecObj);
        }

        // подписываемся на событие атаки для начисление очков власти
        
        this._settlements_settlements_powerPoints.length = this._settlements.length;
        for (var i = 0; i < this._settlements.length; i++) {
            this._settlements_settlements_powerPoints[i] = new Array<number>(this._settlements.length).fill(0);
        }

        var _this = this;
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            this._settlements[settlementNum].Units.UnitCauseDamage.connect(
                function (sender: any, args: any) {
                    // TriggeredUnit - атакующий юнит
                    // VictimUnit - атакованный юнит
                    // Damage - урон до вычита брони
                    // HurtType - тип атаки, Mele
                    
                    var settlementNum      = _this._opSettlementUidToSettlementNum[args.TriggeredUnit.Owner.Uid];
                    var otherSettlementNum = _this._opSettlementUidToSettlementNum[args.VictimUnit.Owner.Uid];

                    // проверяем, что поселения учавствуют в битве FFA, есть замок
                    if (settlementNum == -1 || otherSettlementNum == -1 || _this._settlements_castle[settlementNum] == null) {
                        return;
                    }

                    // если поселения враги
                    if (_this._settlements_settlements_diplomacyStatus[settlementNum][otherSettlementNum] == DiplomacyStatus.War) {
                        // считаем очки власти за удар
                        var powerPointPerHp : number = 0;
                        if (_this._opCfgUidToPowerPointPerHp.has(args.VictimUnit.Cfg.Uid)) {
                            powerPointPerHp = _this._opCfgUidToPowerPointPerHp.get(args.VictimUnit.Cfg.Uid) as number;
                        } else {
                            var cfg = args.VictimUnit.Cfg;
                            powerPointPerHp = 0.01 * (cfg.CostResources.Gold + cfg.CostResources.Metal + cfg.CostResources.Lumber + 50*cfg.CostResources.People) / cfg.MaxHealth;
                            _this._opCfgUidToPowerPointPerHp.set(args.VictimUnit.Cfg.Uid, powerPointPerHp);
                        }
                        var deltaPoints : number = args.Damage * powerPointPerHp * Math.log(Math.max(1,
                            distance_Chebyshev(
                                _this._settlements_castle[settlementNum].Cell.X,
                                _this._settlements_castle[settlementNum].Cell.Y,
                                args.TriggeredUnit.Cell.X,
                                args.TriggeredUnit.Cell.Y
                            )));

                        // учитываем очки власти
                        _this._settlements_powerPoints[settlementNum] += deltaPoints;
                        _this._settlements_settlements_powerPoints[settlementNum][otherSettlementNum] += deltaPoints;
                    }
                    // мирным поселениям восстанавливаем хп
                    else if (_this._settlements_settlements_diplomacyStatus[settlementNum][otherSettlementNum] == DiplomacyStatus.Neutral) {
                        if (args.VictimUnit.Health - args.Damage <= 0) {
                            args.VictimUnit.Health += args.Damage;
                        } else {
                            args.VictimUnit.Health += Math.min(args.VictimUnit.Cfg.MaxHealth - args.VictimUnit.Health, args.Damage);
                        }
                    }
                }
            );
        }

        // инициализируем время до следующей награды

        this._settlements_nextRewardTime.length = this._settlements.length;
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            var settlementCensusModel = ScriptUtils.GetValue(this._settlements[settlementNum].Census, "Model");
            this._settlements_nextRewardTime[settlementNum] = settlementCensusModel.TaxAndSalaryUpdatePeriod;
            log.info("Поселение ", settlementNum, " до следующей награды ", this._settlements_nextRewardTime[settlementNum]);
        }

        // переустанавливаем замки через метод

        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            this._SettlementSetCastle(settlementNum, this._settlements_castle[settlementNum]);
        }
    }

    private _VassalTribute(gameTickNum: number) {
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            if (this._settlements_suzerainNum[settlementNum] == -1) {
                continue;
            }

            var vassal_limitResources = Math.floor(this._vassal_limitResources + 0.1 * this._settlements_powerPoints[settlementNum]);
            var vassal_limitPeople    = Math.floor(this._vassal_limitPeople + 0.002 * this._settlements_powerPoints[settlementNum]);

            // отбираем излишки
            var tribute = createResourcesAmount(
                Math.max(0, this._settlements[settlementNum].Resources.Gold - vassal_limitResources),
                Math.max(0, this._settlements[settlementNum].Resources.Metal - vassal_limitResources),
                Math.max(0, this._settlements[settlementNum].Resources.Lumber - vassal_limitResources),
                Math.max(0, this._settlements[settlementNum].Resources.FreePeople - vassal_limitPeople)
            );

            if (tribute.Gold == 0 && tribute.Metal == 0 && tribute.Lumber == 0 && tribute.People == 0) {
                continue;
            }
            this._settlements[settlementNum].Resources.TakeResources(tribute);
            
            var tribute = createResourcesAmount(
                tribute.Gold,
                tribute.Metal,
                tribute.Lumber,
                0
            );

            // передаем сюзерену
            if (tribute.Gold == 0 && tribute.Metal == 0 && tribute.Lumber == 0) {
                continue;
            }
            this._settlements[this._settlements_suzerainNum[settlementNum]].Resources.AddResources(tribute);
        }
    }

    private _SuzerainGenerosity(gameTickNum: number) {
        var teamsInGame = Array.from(new Set(this._settlements_teamNum));
        for (var teamNum of teamsInGame) {
            var suzerainNum = this._TeamGetSuzerainNum(teamNum);

            // определяем ресурсы для щедрости
            var generosity = createResourcesAmount(
                Math.max(0, this._settlements[suzerainNum].Resources.Gold - this._suzerain_generosityThreshold),
                Math.max(0, this._settlements[suzerainNum].Resources.Metal - this._suzerain_generosityThreshold),
                Math.max(0, this._settlements[suzerainNum].Resources.Lumber - this._suzerain_generosityThreshold),
                0
            );

            var vassalsNum        = this._TeamGetSettlements(teamNum).filter((settlementNum) => settlementNum != suzerainNum);
            if (vassalsNum.length == 0) {
                continue;
            }

            // щедрость равномерно делим по всем
            generosity = createResourcesAmount(
                Math.floor(generosity.Gold / vassalsNum.length),
                Math.floor(generosity.Metal / vassalsNum.length),
                Math.floor(generosity.Lumber / vassalsNum.length),
                0
            );

            // проверяем, что есть ресурсы для щедрости
            if (generosity.Gold == 0 && generosity.Metal == 0 && generosity.Lumber == 0) {
                continue;
            }

            // делимся деньгами с вассалами
            var givenGold   = 0;
            var givenMetal  = 0;
            var givenLumber = 0;
            for (var vassalNum of vassalsNum) {
                var pay = createResourcesAmount(
                    Math.max(0, Math.min(generosity.Gold, Math.floor(this._vassal_limitResources + 0.1 * this._settlements_powerPoints[vassalNum]) - this._settlements[vassalNum].Resources.Gold)),
                    Math.max(0, Math.min(generosity.Metal, Math.floor(this._vassal_limitResources + 0.1 * this._settlements_powerPoints[vassalNum]) - this._settlements[vassalNum].Resources.Metal)),
                    Math.max(0, Math.min(generosity.Lumber, Math.floor(this._vassal_limitResources + 0.1 * this._settlements_powerPoints[vassalNum]) - this._settlements[vassalNum].Resources.Lumber)),
                    0
                );

                // проверяем, что вассалу нужна щедрость
                if (pay.Gold == 0 && pay.Metal == 0 && pay.Lumber == 0) {
                    continue;
                }
                
                givenGold   += pay.Gold;
                givenMetal  += pay.Metal;
                givenLumber += pay.Lumber;
                this._settlements[vassalNum].Resources.AddResources(pay);
            }

            // отнимаем щедрость у сюзерена
            if (givenGold != 0 || givenMetal != 0 || givenLumber != 0) {
                this._settlements[suzerainNum].Resources.TakeResources(createResourcesAmount(givenGold, givenMetal, givenLumber, 0));
            }
        }
    }

    private _TeamMigration(gameTickNum: number) {
        // обрабатываем вассалов
        for (var loserVassalNum = 0; loserVassalNum < this._settlements.length; loserVassalNum++) {
            // проверяем, что вассал и лишился замка
            if (!this._settlements_isDefeat[loserVassalNum]
                || this._settlements_suzerainNum[loserVassalNum] == -1) {
                continue;
            }

            // проверяем, что есть победитель
            var loserTeamNum    = this._settlements_teamNum[loserVassalNum];
            var winnerTeamNum   = this._TeamGetEnemyTeamNum(loserTeamNum);
            if (winnerTeamNum == -1) {
                continue;
            }
            this.log.info("Вассал ", loserVassalNum, " проиграл, он переходит из ", loserTeamNum, " в ", winnerTeamNum);

            // оповещаем всех

            var winnerSuzerainNum    = this._TeamGetSuzerainNum(winnerTeamNum);
            var loserSuzerainNum     = this._TeamGetSuzerainNum(loserTeamNum);
            var winnerSettlementsNum = this._TeamGetSettlements(winnerTeamNum);
            var winnerTeamSize       = winnerSettlementsNum.length + 1;
            var loserTeamSize        = this._TeamGetSettlements(winnerTeamNum).length - 1;
            for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
                if (loserVassalNum == settlementNum) {
                    continue;
                } else if (this._settlements_teamNum[settlementNum] == loserTeamNum) {
                    var message : string = "Ваш вассал " + this._settlements_name[loserVassalNum] + " перешел на сторону врага!";
                    var color   = this._settlements[loserVassalNum].SettlementColor;
                    let msg     = createGameMessageWithSound(message, color);
                    this._settlements[settlementNum].Messages.AddMessage(msg);
                } else if (this._settlements_teamNum[settlementNum] == winnerTeamNum) {
                    var message : string = "К вам присоединился вассал врага " + this._settlements_name[loserVassalNum];
                    var color   = this._settlements[loserVassalNum].SettlementColor;
                    let msg     = createGameMessageWithSound(message, color);
                    this._settlements[settlementNum].Messages.AddMessage(msg);
                } else {
                    var message : string = "Баланс сил нарушен! Сюзерен " + this._settlements_name[winnerSuzerainNum] + " переманил вассала у " + this._settlements_name[loserSuzerainNum];
                        + ", итого " + winnerTeamSize + " против " + loserTeamSize;
                    var color   = createHordeColor(255, 150, 150, 150);
                    let msg     = createGameMessageWithNoSound(message, color);
                    this._settlements[settlementNum].Messages.AddMessage(msg);
                }
            }

            // обновляем очки власти (отбираем у проигравшего вассала процент и распределяем его по всем)

            this._TeamShareSettlementPowerPoints(winnerTeamNum, loserVassalNum);

            // переводим вассала
            
            this._TeamAddVassal(winnerTeamNum, loserVassalNum);
        }

        // обрабатываем сюзеренов
        for (var loserSuzerainNum = 0; loserSuzerainNum < this._settlements.length; loserSuzerainNum++) {
            // проверяем, что сюзерен и проиграл
            if (!this._settlements_isDefeat[loserSuzerainNum]
                || this._settlements_suzerainNum[loserSuzerainNum] != -1) {
                continue;
            }

            // проверяем, что есть победитель
            var loserTeamNum  = this._settlements_teamNum[loserSuzerainNum];
            var winnerTeamNum = this._TeamGetEnemyTeamNum(this._settlements_teamNum[loserSuzerainNum]);
            if (winnerTeamNum == -1) {
                continue;
            }
            var winnerSuzerainNum = this._TeamGetSuzerainNum(winnerTeamNum);

            // обновляем очки власти

            for (var loserSettlementNum = 0; loserSettlementNum < this._settlements.length; loserSettlementNum++) {
                if (this._settlements_teamNum[loserSettlementNum] == loserTeamNum) {
                    this._TeamShareSettlementPowerPoints(winnerTeamNum, loserSettlementNum);
                }
            }

            // делаем всю команду вассалами

            var vassalStr = "";
            for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
                if (this._settlements_teamNum[settlementNum] == this._settlements_teamNum[loserSuzerainNum]) {
                    vassalStr += settlementNum + " ";
                }
            }
            this.log.info("Сюзерен ", loserSuzerainNum, " проиграл, он переходит из ", this._settlements_teamNum[loserSuzerainNum], " в ", winnerTeamNum, " вместе с вассалами ", vassalStr);
            
            this._TeamAddSuzerain(winnerTeamNum, loserSuzerainNum);

            // оповещаем всех

            var winnerSettlementsNum = this._TeamGetSettlements(winnerTeamNum);
            var winnerVassalsStr = "";
            for (var settlementNum of winnerSettlementsNum) {
                if (settlementNum == winnerSuzerainNum) {
                    continue;
                }
                winnerVassalsStr += this._settlements_name[settlementNum] + " ";
            }
            broadcastMessage("Сюзерен " + this._settlements_name[winnerSuzerainNum] + " победил врага, теперь под его началом служат следующие вассалы:\n"
                + winnerVassalsStr
                , createHordeColor(255, 150, 150, 150)
            );
            for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
                if (this._settlements_teamNum[settlementNum] == winnerTeamNum) {
                    var message : string = "Вы стали ближе к правлению этими землями, ожидайте следующего врага!";
                    var color   = createHordeColor(255, 150, 150, 150);
                    let msg     = createGameMessageWithSound(message, color);
                    this._settlements[settlementNum].Messages.AddMessage(msg);
                }
            }

            // запоминаем такт победы и зануляем номер оповещения
            this._teams_lastVictoryGameTickNum[winnerTeamNum]  = gameTickNum;
            this._teams_truceNotificationNumber[winnerTeamNum] = 0;
        }
    }

    private _ChoiseEnemyTeam(gameTickNum: number) {
        var that = this;
        const freeTeams = Array.from(new Set(this._settlements_teamNum)).filter((teamNum) => {
            return that._TeamGetEnemyTeamNum(teamNum) == -1;
        });
        let rnd = ActiveScena.GetRealScena().Context.Randomizer;
        if (freeTeams.length == 1) {
            // у команды долго нет врага
            if (this._teams_lastVictoryGameTickNum[freeTeams[0]] + 0.5*this._team_truceTime < gameTickNum && this._teams_truceNotificationNumber[freeTeams[0]] == 0) {
                broadcastMessage("Сюзерен " + this._settlements_name[this._TeamGetSuzerainNum(freeTeams[0])] + " теряет терпение и скоро вступится за слабого!",
                    createHordeColor(255, 255, 140, 140));
                this._teams_truceNotificationNumber[freeTeams[0]] = 1;
            } else if (this._teams_lastVictoryGameTickNum[freeTeams[0]] + this._team_truceTime - 50*60 < gameTickNum && this._teams_truceNotificationNumber[freeTeams[0]] == 1) {
                broadcastMessage("Сюзерен " + this._settlements_name[this._TeamGetSuzerainNum(freeTeams[0])] + " потерял терпение и через минуту вступится за слабого!",
                    createHordeColor(255, 255, 140, 140));
                this._teams_truceNotificationNumber[freeTeams[0]] = 2;
            } else if (this._teams_lastVictoryGameTickNum[freeTeams[0]] + this._team_truceTime < gameTickNum) {
                this.log.info("team ", freeTeams[0], " many times in peace");
                // вычисляем силу поселений
                var teamsTop = Array.from(new Set(this._settlements_teamNum));
                var teams_power = new Array<number>(this._settlements.length).fill(0);
                for (var teamNum of teamsTop) {
                    teams_power[teamNum] = this._TeamGetPower(teamNum);
                }
                teamsTop.sort((teamA: any, teamB: any) => teams_power[teamA] - teams_power[teamB]);
                for (var teamNum of teamsTop) {
                    this.log.info("team ", teamNum, " power ", teams_power[teamNum]);
                }

                // выбираем какая команда куда мигрирует
                if (teamsTop[0] == freeTeams[0]) {
                    this.log.info("team ", freeTeams[0], " new vassal of ", teamsTop[0]);

                    // отнимаем очки власти 

                    for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
                        if (this._settlements_teamNum[settlementNum] == freeTeams[0]) {
                            this._TeamShareSettlementPowerPoints(teamsTop[0], settlementNum);
                        }
                    }

                    // объединяем команды

                    broadcastMessage("Сюзерен " + this._settlements_name[this._TeamGetSuzerainNum(freeTeams[0])] + " решил стать вассалом " + this._settlements_name[this._TeamGetSuzerainNum(teamsTop[1])],
                        createHordeColor(255, 255, 140, 140));
                    this._TeamAddSuzerain(teamsTop[1], this._TeamGetSuzerainNum(freeTeams[0]), true);
                } else {
                    this.log.info("team ", freeTeams[0], " new suzerain of ", teamsTop[0]);

                    // отнимаем очки власти

                    for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
                        if (this._settlements_teamNum[settlementNum] == teamsTop[0]) {
                            this._TeamShareSettlementPowerPoints(freeTeams[0], settlementNum);
                        }
                    }

                    // объединяем команды

                    broadcastMessage("Сюзерен " + this._settlements_name[this._TeamGetSuzerainNum(freeTeams[0])] + " решил стать сюзереном " + this._settlements_name[this._TeamGetSuzerainNum(teamsTop[0])],
                        createHordeColor(255, 255, 140, 140));
                    var enemyTeam = this._TeamGetEnemyTeamNum(teamsTop[0]);
                    this._TeamAddSuzerain(freeTeams[0], this._TeamGetSuzerainNum(teamsTop[0]), true);

                    // объявляем войну вражеской команде
                    
                    for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
                        if (this._settlements_teamNum[settlementNum] != freeTeams[0]) {
                            continue;
                        }
                        for (var otherSettlementNum = 0; otherSettlementNum < this._settlements.length; otherSettlementNum++) {
                            if (this._settlements_teamNum[otherSettlementNum] == enemyTeam) {
                                this._settlements[settlementNum].Diplomacy.DeclareWar(this._settlements[otherSettlementNum]);
                                this._settlements[otherSettlementNum].Diplomacy.DeclareWar(this._settlements[settlementNum]);
                                this._settlements_settlements_diplomacyStatus[settlementNum][otherSettlementNum] = DiplomacyStatus.War;
                                this._settlements_settlements_diplomacyStatus[otherSettlementNum][settlementNum] = DiplomacyStatus.War;
                            }
                        }
                    }
                }
            }
        } else {
            while (freeTeams.length > 1) {
                var number    = rnd.RandomNumber(0, freeTeams.length - 1);
                var team1_num = freeTeams[number];
                freeTeams.splice(number, 1);
                number        = rnd.RandomNumber(0, freeTeams.length - 1);
                var team2_num = freeTeams[number];
                freeTeams.splice(number, 1);

                var team1_suzerainNum = this._TeamGetSuzerainNum(team1_num);
                var team2_suzerainNum = this._TeamGetSuzerainNum(team2_num);

                var team1_settlements = this._TeamGetSettlements(team1_num);
                var team2_settlements = this._TeamGetSettlements(team2_num);

                var team1_vassalsStr = "";
                var team2_vassalsStr = "";
                for (var settlementNum of team1_settlements) {
                    if (settlementNum == team1_suzerainNum) {
                        continue;
                    }
                    team1_vassalsStr += this._settlements_name[settlementNum] + " ";
                }
                for (var settlementNum of team2_settlements) {
                    if (settlementNum == team2_suzerainNum) {
                        continue;
                    }
                    team2_vassalsStr += this._settlements_name[settlementNum] + " ";
                }

                //var message = "Между сюзереном " + this._settlements_name[team1_suzerainNum] + (team1_vassalsStr != "" ? " и вассалами " + team1_vassalsStr : "") + "\n"
                //            + " и сюзереном " + this._settlements_name[team2_suzerainNum] + (team2_vassalsStr != "" ? " и вассалами " + team2_vassalsStr : "") + " объявлена война!\n";
                var message = "Между сюзереном " + this._settlements_name[team1_suzerainNum] + " (" + (team1_settlements.length - 1) + " вассалов)"
                    + " и сюзереном " + this._settlements_name[team2_suzerainNum] + " (" + (team2_settlements.length - 1) + " вассалов) объявлена война!\n";
                broadcastMessage(message, createHordeColor(255, 255, 140, 140));

                for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
                    if (this._settlements_teamNum[settlementNum] != team1_num) {
                        continue;
                    }
                    for (var otherSettlementNum = 0; otherSettlementNum < this._settlements.length; otherSettlementNum++) {
                        if (this._settlements_teamNum[otherSettlementNum] == team2_num) {
                            this._settlements[settlementNum].Diplomacy.DeclareWar(this._settlements[otherSettlementNum]);
                            this._settlements[otherSettlementNum].Diplomacy.DeclareWar(this._settlements[settlementNum]);
                            this._settlements_settlements_diplomacyStatus[settlementNum][otherSettlementNum] = DiplomacyStatus.War;
                            this._settlements_settlements_diplomacyStatus[otherSettlementNum][settlementNum] = DiplomacyStatus.War;
                        }
                    }
                }
            }
        }
    }

    private _UpdatePowerPointStrDecorators(gameTickNum: number) {
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            this._settlements_powerPointStrDecorators[settlementNum].Text = 
                "Очки власти: " + Math.round(this._settlements_powerPoints[settlementNum]);
        }
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            this._settlements_statusStrDecorators[settlementNum].Text = this._settlements_suzerainNum[settlementNum] == -1 ? "сюзерен" : "вассал";
        }
    }

    private _AutomaticChangeSuzerain(gameTickNum: number) {
        var settlementCheckFlag = new Array<boolean>(this._settlements.length).fill(false);
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            if (settlementCheckFlag[settlementNum]) {
                continue;
            }

            var teamNum     = this._settlements_teamNum[settlementNum];
            var suzerainNum = this._TeamGetSuzerainNum(teamNum);
            
            var teamSettlements = this._TeamGetSettlements(teamNum);
            var powerfulSettlementNum   = suzerainNum;
            var powerfulSettlementPower = this._settlements_powerPoints[powerfulSettlementNum];

            for (var otherSettlementNum of teamSettlements) {
                settlementCheckFlag[otherSettlementNum] = true;

                if (powerfulSettlementPower < this._settlements_powerPoints[otherSettlementNum]) {
                    powerfulSettlementNum   = otherSettlementNum;
                    powerfulSettlementPower = this._settlements_powerPoints[otherSettlementNum];
                }
            }

            // смена сюзерена!
            if (powerfulSettlementNum != suzerainNum) {
                this._TeamChangeSuzerain(teamNum, powerfulSettlementNum);
                
                // оповещаем о перестановке
                var enemyTeamNum = this._TeamGetEnemyTeamNum(teamNum);
                var message      = "Сюзерен " + this._settlements_name[suzerainNum] + " уступил своё сюзеренство " + this._settlements_name[powerfulSettlementNum];
                for (var otherSettlementNum = 0; otherSettlementNum < this._settlements.length; otherSettlementNum++) {
                    if (this._settlements_teamNum[otherSettlementNum] == teamNum
                        || this._settlements_teamNum[otherSettlementNum] == enemyTeamNum
                    ) {
                        var color   = this._settlements[powerfulSettlementNum].SettlementColor;
                        let msg     = createGameMessageWithSound(message, color);
                        this._settlements[otherSettlementNum].Messages.AddMessage(msg);
                    } else {
                        var color   = this._settlements[powerfulSettlementNum].SettlementColor;
                        let msg     = createGameMessageWithNoSound(message, color);
                        this._settlements[otherSettlementNum].Messages.AddMessage(msg);
                    }
                }
            }
        }
    }

    private _SettlementsReward(gameTickNum: number) {
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            if (this._settlements_nextRewardTime[settlementNum] < gameTickNum) {
                var settlementCensusModel = ScriptUtils.GetValue(this._settlements[settlementNum].Census, "Model");
                this._settlements_nextRewardTime[settlementNum] += settlementCensusModel.TaxAndSalaryUpdatePeriod;

                log.info("Поселение ", settlementNum, " до следующей награды ", this._settlements_nextRewardTime[settlementNum]);

                if (this._settlements_powerPoints[settlementNum] < 10) {
                    continue;
                }

                var reward = createResourcesAmount(
                    Math.floor(this._powerPoints_rewardPercentage * this._settlements_powerPoints[settlementNum]),
                    Math.floor(this._powerPoints_rewardPercentage * this._settlements_powerPoints[settlementNum]),
                    Math.floor(this._powerPoints_rewardPercentage * this._settlements_powerPoints[settlementNum]),
                    Math.floor(0.02 * this._powerPoints_rewardPercentage * this._settlements_powerPoints[settlementNum])
                );
                this._settlements[settlementNum].Resources.AddResources(reward);
            }
        }
    }

    private _DeffeatCheck(gameTickNum: number) {
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            if (!this._settlements_castle[settlementNum] || this._settlements_castle[settlementNum].IsDead) {
                this.log.debug(this._settlements_name[settlementNum], "(", settlementNum, ") потерял главный замок, isDefeat = true");
                this._settlements_isDefeat[settlementNum] = true;
            } else {
                this._settlements_isDefeat[settlementNum] = false;
            }
        }
    }

    private _EndGameCheck(gameTickNum: number) {
        var winnerSuzerainNum = this._settlements_suzerainNum[0] == -1 ? 0 : this._settlements_suzerainNum[0];
        var isVictory         = true;
        for (var settlementNum = 1; settlementNum < this._settlements.length; settlementNum++) {
            var suzerainNum = this._settlements_suzerainNum[settlementNum] == -1 ? settlementNum : this._settlements_suzerainNum[settlementNum];
            if (winnerSuzerainNum != suzerainNum) {
                isVictory = false;
                break;
            }
        }

        if (!isVictory) {
            return;
        }

        this._endGame = true;

        var message = "Единственным правителем земель стал " + this._settlements_name[winnerSuzerainNum] + "\n";
        broadcastMessage(message, this._settlements[winnerSuzerainNum].SettlementColor);
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            //if (settlementNum == winnerSuzerainNum) {
                this._settlements[settlementNum].Existence.ForceVictory();
            //} else {
            //    this._settlements[settlementNum].Existence.ForceTotalDefeat();
            //}
        }
    }

    /** вернет номер враждующей команды, если нету, то -1 */
    private _TeamGetEnemyTeamNum (teamNum: number) : number {
        var enemy = -1;
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            if (this._settlements_teamNum[settlementNum] != teamNum) {
                continue;
            }

            for (var otherSettlementNum = 0; otherSettlementNum < this._settlements.length; otherSettlementNum++) {
                if (this._settlements_teamNum[otherSettlementNum] == teamNum) {
                    continue;
                }

                if (this._settlements[settlementNum].Diplomacy.GetDiplomacyStatus(this._settlements[otherSettlementNum]) == DiplomacyStatus.War) {
                    enemy = this._settlements_teamNum[otherSettlementNum];
                    break;
                }
            }
            break;
        }
        return enemy;
    }

    private _TeamGetSuzerainNum (teamNum: number) : number {
        var res = -1;
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            if (this._settlements_teamNum[settlementNum] == teamNum) {
                res = this._settlements_suzerainNum[settlementNum] == -1
                ? settlementNum
                : this._settlements_suzerainNum[settlementNum];
                break;
            }
        }
        return res;
    }

    private _TeamChangeSuzerain (teamNum: number, suzerainNum: number) {
        var teamSettlements = this._TeamGetSettlements(teamNum);

        for (var settlementNum of teamSettlements) {
            if (suzerainNum == settlementNum) {
                this._settlements_suzerainNum[settlementNum] = -1;
            } else {
                this._settlements_suzerainNum[settlementNum] = suzerainNum;
            }
        }
    }

    private _TeamAddVassal(teamNum: number, settlementNum: number, silent: boolean = false) {
        var enemyTeamNum                              = this._TeamGetEnemyTeamNum(teamNum);
        var suzerainNum                               = this._TeamGetSuzerainNum(teamNum);
        var prevSuzerainNum                           = this._settlements_suzerainNum[teamNum];

        // обновляем командю и сюзерена

        this._settlements_suzerainNum[settlementNum]  = suzerainNum;
        this._settlements_teamNum[settlementNum]      = this._settlements_teamNum[suzerainNum];

        // обновляем дипломатию

        for (var otherSettlementNum = 0; otherSettlementNum < this._settlements.length; otherSettlementNum++) {
            if (this._settlements_teamNum[otherSettlementNum] == teamNum) {
                if (!silent) this.log.info("союз между ", settlementNum, " и ", otherSettlementNum);
                this._settlements[settlementNum].Diplomacy.DeclareAlliance(this._settlements[otherSettlementNum]);
                this._settlements[otherSettlementNum].Diplomacy.DeclareAlliance(this._settlements[settlementNum]);
                this._settlements_settlements_diplomacyStatus[settlementNum][otherSettlementNum] = DiplomacyStatus.Alliance;
                this._settlements_settlements_diplomacyStatus[otherSettlementNum][settlementNum] = DiplomacyStatus.Alliance;
            } else if (!this._settlements_isDefeat[prevSuzerainNum] && this._settlements_teamNum[otherSettlementNum] == enemyTeamNum) {
                if (!silent) this.log.info("война между ", settlementNum, " и ", otherSettlementNum);
                this._settlements[settlementNum].Diplomacy.DeclareWar(this._settlements[otherSettlementNum]);
                this._settlements[otherSettlementNum].Diplomacy.DeclareWar(this._settlements[settlementNum]);
                this._settlements_settlements_diplomacyStatus[settlementNum][otherSettlementNum] = DiplomacyStatus.War;
                this._settlements_settlements_diplomacyStatus[otherSettlementNum][settlementNum] = DiplomacyStatus.War;
            }
        }

        if (!silent) this.log.debug(this._settlements_name[settlementNum], "(", settlementNum, ") стал вассалом команды ", teamNum, " isDef = ", this._settlements_isDefeat[settlementNum]);

        if (!this._settlements_isDefeat[settlementNum]) {
            return;
        }

        // выбираем место спавна замка

        let sumCount  = 0;
        let sumValueX = 0;
        let sumValueY = 0;

        let enumerator = this._settlements[settlementNum].Units.GetEnumerator();
        while(enumerator.MoveNext()) {
            if (enumerator.Current && enumerator.Current.Cfg.IsBuilding) {
                sumValueX += enumerator.Current.Cell.X;
                sumValueY += enumerator.Current.Cell.Y;
                sumCount  ++;   
            }
        }
        enumerator.Dispose();

        var spawnPosition : Point2D;
        if (sumCount == 0) {
            var castlesPositions = new Array<Point2D>();

            enumerator = this._settlements[suzerainNum].Units.GetEnumerator();
            while(enumerator.MoveNext()) {
                if (enumerator.Current && enumerator.Current.Cfg.HasMainBuildingSpecification) {
                    castlesPositions.push(enumerator.Current.Cell);
                }
            }
            enumerator.Dispose();

            let rnd       = ActiveScena.GetRealScena().Context.Randomizer;
            var number    = rnd.RandomNumber(0, castlesPositions.length - 1);
            spawnPosition = castlesPositions[number];
        } else {
            spawnPosition = createPoint(Math.round(sumValueX / sumCount - 2), Math.round(sumValueY / sumCount - 1));
        }

        // спавним замок в spawnPosition так, чтобы в 1 клетке от замка ничего не было

        var generator                 = generateCellInSpiral(spawnPosition.X, spawnPosition.Y);
        let spawnParams               = new SpawnUnitParameters();
        spawnParams.ProductUnitConfig = this._settlements_castleCfg[settlementNum];
        spawnParams.Direction         = UnitDirection.RightDown;
        for (let position = generator.next(); !position.done; position = generator.next()) {
            if (unitCanBePlacedByRealMap(this._settlements_castleCfg[settlementNum], position.value.X + 1, position.value.Y + 1) &&
                unitCanBePlacedByRealMap(this._settlements_castleCfg[settlementNum], position.value.X, position.value.Y) &&
                unitCanBePlacedByRealMap(this._settlements_castleCfg[settlementNum], position.value.X - 1, position.value.Y - 1)) {
                spawnParams.Cell = createPoint(position.value.X, position.value.Y);
                var castle = this._settlements[settlementNum].Units.SpawnUnit(spawnParams);

                if (castle) {
                    if (!silent) {
                        this.log.debug("\tему был дарован замок в позиции: ", position.value.X, ",", position.value.Y, " замок = ", castle);
                        var msg = createGameMessageWithSound("Ваш сюзерен " + this._settlements_name[suzerainNum] + " привествует тебя в своих рядах. Вам был дарован замок в позиции "
                            + position.value.X + ", " + position.value.Y, createHordeColor(255, 150, 150, 150));
                        this._settlements[settlementNum].Messages.AddMessage(msg);
                    }
                    this._SettlementSetCastle(settlementNum, castle);
                    break;
                }
            }
        }

        // передаем ресурсы сверх пределов (и даже популяцию)

        var vassal_limitResources = Math.floor(this._vassal_limitResources + this._powerPoints_rewardPercentage * this._settlements_powerPoints[settlementNum]);
        var vassal_limitPeople    = Math.floor(this._vassal_limitPeople + 0.02 * this._powerPoints_rewardPercentage * this._settlements_powerPoints[settlementNum]);

        var tribute = createResourcesAmount(
            Math.max(0, this._settlements[settlementNum].Resources.Gold - vassal_limitResources),
            Math.max(0, this._settlements[settlementNum].Resources.Metal - vassal_limitResources),
            Math.max(0, this._settlements[settlementNum].Resources.Lumber - vassal_limitResources),
            Math.max(0, this._settlements[settlementNum].Resources.FreePeople - vassal_limitPeople)
        );
        if (tribute.Gold != 0 || tribute.Metal != 0 || tribute.Lumber != 0 || tribute.People != 0) {
            this._settlements[settlementNum].Resources.TakeResources(tribute);
            this._settlements[suzerainNum].Resources.AddResources(tribute);
        }
        
        // снимаем флаг поражения

        this._settlements_isDefeat[settlementNum] = false;
    }

    private _TeamAddSuzerain(teamNum: number, settlementNum: number, silent: boolean = false) {
        var loserTeamNum      = this._settlements_teamNum[settlementNum];
        var winnerSuzerainNum = this._TeamGetSuzerainNum(teamNum);
        var loserVassals      = this._TeamGetSettlements(loserTeamNum);

        // подготовка данных чтобы союзы не сломались

        for (var otherSettlementNum of loserVassals) {
            this._settlements_teamNum[otherSettlementNum]     = teamNum;
            this._settlements_suzerainNum[otherSettlementNum] = winnerSuzerainNum;
        }

        // добавляем вассалов
        for (var otherSettlementNum of loserVassals) {
            if (!silent) this.log.info("Его вассал ", otherSettlementNum, " проиграл, он переходит из ", this._settlements_teamNum[otherSettlementNum], " в ", teamNum);
            this._TeamAddVassal(teamNum, otherSettlementNum, silent);
        }
    }

    private _TeamGetSettlements(teamNum: number) {
        var res = new Array<number>();
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            if (this._settlements_teamNum[settlementNum] != teamNum) {
                continue;
            }
            res.push(settlementNum);
        }
        return res;
    }

    private _TeamGetPower(teamNum: number) : number {
        var teamSettlements = this._TeamGetSettlements(teamNum);
        var power : number  = 0;

        for (var settlementNum of teamSettlements) {
            power += this._SettlementGetPower(settlementNum);
        }

        return power;
    }

    private _SettlementGetPower(settlementNum: number) : number {
        var power = this._settlements[settlementNum].Resources.Gold + this._settlements[settlementNum].Resources.Metal + this._settlements[settlementNum].Resources.Lumber + 50*this._settlements[settlementNum].Resources.FreePeople;

        let enumerator = this._settlements[settlementNum].Units.GetEnumerator();
        while(enumerator.Current && enumerator.MoveNext()) {
            power += enumerator.Current.Cfg.CostResources.Gold + enumerator.Current.Cfg.CostResources.Metal + enumerator.Current.Cfg.CostResources.Lumber + 50*enumerator.Current.Cfg.CostResources.People;
        }
        enumerator.Dispose();

        return power;
    }

    private _CreateCastleFrameBuffer(settlementNum: number) {
        // Объект для низкоуровневого формирования геометрии
        let geometryCanvas = new GeometryCanvas();
        
        const width  = this._settlements_castleCfg[settlementNum].Size.Width * 32;
        const height = this._settlements_castleCfg[settlementNum].Size.Height * 32;

        var points = host.newArr(Stride_Vector2, 5) as Stride_Vector2[];
        points[0] = new Stride_Vector2(Math.round(-0.7*width),  Math.round(-0.7*height));
        points[1] = new Stride_Vector2(Math.round( 0.7*width),  Math.round(-0.7*height));
        points[2] = new Stride_Vector2(Math.round( 0.7*width),  Math.round( 0.7*height));
        points[3] = new Stride_Vector2(Math.round(-0.7*width),  Math.round( 0.7*height));
        points[4] = new Stride_Vector2(Math.round(-0.7*width),  Math.round(-0.7*height));

        geometryCanvas.DrawPolyLine(points, new Stride_Color(this._settlements[settlementNum].SettlementColor.R, this._settlements[settlementNum].SettlementColor.G, this._settlements[settlementNum].SettlementColor.B), 3.0, false);

        return geometryCanvas.GetBuffers();
    }

    private _SettlementSetCastle(settlementNum: number, castleUnit: any) {
        this._settlements_castle[settlementNum] = castleUnit;

        // запрещаем самоуничтожение
        var commandsMind       = castleUnit.CommandsMind;
        var disallowedCommands = ScriptUtils.GetValue(commandsMind, "DisallowedCommands");
        if (!disallowedCommands.ContainsKey(UnitCommand.DestroySelf)) {
            disallowedCommands.Add(UnitCommand.DestroySelf, 1);
        }

        // двигаем рамку
        this._settlements_castleFrame[settlementNum].Position = castleUnit.Position;

        // двигаем очки власти
        this._settlements_powerPointStrDecorators[settlementNum].Position = createPoint(32*(castleUnit.Cell.X - 1), Math.floor(32*(castleUnit.Cell.Y - 1.3)));
        
        // двигаем статус игрока
        this._settlements_statusStrDecorators[settlementNum].Position = createPoint(Math.floor(32*(castleUnit.Cell.X + 2.7)), Math.floor(32*(castleUnit.Cell.Y + 3.6)));
    }

    private _TeamShareSettlementPowerPoints(teamNum: number, targetSettlementNum: number) {
        var distributedPowerPoints = this._settlements_powerPoints[targetSettlementNum] *
            (this._settlements_suzerainNum[targetSettlementNum] == -1
             ? this._suzerain_powerPoints_takenPercentage
             : this._vassal_powerPoints_takenPercentage);
        this._settlements_powerPoints[targetSettlementNum] -= distributedPowerPoints;

        var fullIntegral : number = 0.0;
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            if (this._settlements_teamNum[settlementNum] == teamNum) {
                fullIntegral += Math.max(1, this._settlements_settlements_powerPoints[settlementNum][targetSettlementNum]);
            }
        }
        log.info("loserVassalNum ", targetSettlementNum, " всего очков ", this._settlements_powerPoints[targetSettlementNum] + distributedPowerPoints, " отнято очков distribtedPowerPoints ", distributedPowerPoints, " его враги заработали суммарно очков власти ", fullIntegral);
        for (var settlementNum = 0; settlementNum < this._settlements.length; settlementNum++) {
            if (this._settlements_teamNum[settlementNum] == teamNum) {
                const partPowerPoints  = Math.max(1, this._settlements_settlements_powerPoints[settlementNum][targetSettlementNum]) / fullIntegral;
                const deltaPowerPoints = distributedPowerPoints * partPowerPoints;
                this._settlements_powerPoints[settlementNum] += deltaPowerPoints;
                log.info("\twinnerSettlementNum ", settlementNum, " получает долю ", partPowerPoints, " равную ", deltaPowerPoints);
                var msg = createGameMessageWithSound("За победу над " + this._settlements_name[targetSettlementNum]
                    + " вам начислено очков власти: "+ Math.round(deltaPowerPoints)
                    + " (" + Math.round(partPowerPoints * 100) + "%)",
                    createHordeColor(255, 150, 150, 150));
                this._settlements[settlementNum].Messages.AddMessage(msg);

                this._settlements_settlements_powerPoints[settlementNum][targetSettlementNum] = 0;
                this._settlements_settlements_powerPoints[targetSettlementNum][settlementNum] = 0;
            }
        }
    }
}
