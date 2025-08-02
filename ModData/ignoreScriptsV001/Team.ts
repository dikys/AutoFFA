import { FfaParticipant } from "./FfaParticipant";
import { createResourcesAmount, ResourcesAmount } from "library/common/primitives";
import { createGameMessageWithSound, broadcastMessage } from "library/common/messages";
import { DiplomacyStatus } from "library/game-logic/horde-types";

/**
 * Представляет команду (альянс), состоящую из сюзерена и его вассалов.
 * Управляет командной дипломатией и действиями.
 */
export class Team {
    public static readonly SUZERAIN_GENEROSITY_THRESHOLD = 5000;

    public readonly id: number;
    private _suzerain: FfaParticipant;
    private _vassals: Map<number, FfaParticipant> = new Map();

    private _enemyTeam: Team | null = null;
    public lastVictoryTick: number = 0;
    public truceNotificationState: number = 0;

    constructor(id: number, initialSuzerain: FfaParticipant) {
        this.id = id;
        this._suzerain = initialSuzerain;
        this._suzerain.teamId = this.id;
        this._suzerain.suzerain = null;
    }

    public get enemyTeam(): Team | null {
        return this._enemyTeam;
    }

    public set enemyTeam(team: Team | null) {
        this._enemyTeam = team;
    }

    public get suzerain(): FfaParticipant {
        return this._suzerain;
    }

    public get vassals(): FfaParticipant[] {
        return Array.from(this._vassals.values());
    }

    public getMembers(): FfaParticipant[] {
        return [this._suzerain, ...this.vassals];
    }

    public getMemberCount(): number {
        return 1 + this._vassals.size;
    }

    public removeVassal(vassal: FfaParticipant) {
        this._vassals.delete(vassal.id);
        vassal.teamId = vassal.id; // Возвращается в свою "команду"
    }

    public addVassal(vassal: FfaParticipant): void {
        this._vassals.set(vassal.id, vassal);
        vassal.teamId = this.id;
        vassal.suzerain = this._suzerain;

        this.updateDiplomacyOnJoin(vassal);

        if (vassal.isDefeated) {
            vassal.respawnCastle();
            const msg = createGameMessageWithSound(`Ваш сюзерен ${this.suzerain.name} привествует тебя в своих рядах. Вам был дарован замок.`, this.suzerain.settlement.SettlementColor);
            vassal.settlement.Messages.AddMessage(msg);
        }
    }

    public addSuzerainAndVassals(formerSuzerain: FfaParticipant, formerVassals: FfaParticipant[]): void {
        this.addVassal(formerSuzerain);
        for (const vassal of formerVassals) {
            this.addVassal(vassal);
        }
    }

    public promoteNewSuzerainIfNeeded(): void {
        let mostPowerful: FfaParticipant = this._suzerain;

        for (const vassal of this.vassals) {
            if (vassal.powerPoints > mostPowerful.powerPoints) {
                mostPowerful = vassal;
            }
        }

        if (mostPowerful.id !== this._suzerain.id) {
            const oldSuzerain = this._suzerain;
            this.changeSuzerain(mostPowerful);
            broadcastMessage(`Сюзерен ${oldSuzerain.name} уступил своё место более влиятельному вассалу ${mostPowerful.name}!`, this.suzerain.settlement.SettlementColor);
        }
    }

    private changeSuzerain(newSuzerain: FfaParticipant): void {
        const oldSuzerain = this._suzerain;

        this._vassals.delete(newSuzerain.id);
        newSuzerain.suzerain = null;

        this._vassals.set(oldSuzerain.id, oldSuzerain);
        oldSuzerain.suzerain = newSuzerain;

        this._suzerain = newSuzerain;

        for (const vassal of this.vassals) {
            if (vassal.id !== oldSuzerain.id) {
                vassal.suzerain = newSuzerain;
            }
        }
    }

    public distributeGenerosity(): void {
        const suzerainRes = this._suzerain.settlement.Resources;
        const generosity = createResourcesAmount(
            Math.max(0, suzerainRes.Gold - Team.SUZERAIN_GENEROSITY_THRESHOLD),
            Math.max(0, suzerainRes.Metal - Team.SUZERAIN_GENEROSITY_THRESHOLD),
            Math.max(0, suzerainRes.Lumber - Team.SUZERAIN_GENEROSITY_THRESHOLD),
            0
        );

        if (this._vassals.size === 0 || (generosity.Gold === 0 && generosity.Metal === 0 && generosity.Lumber === 0)) return;

        const sharePerVassal = createResourcesAmount(Math.floor(generosity.Gold / this._vassals.size), Math.floor(generosity.Metal / this._vassals.size), Math.floor(generosity.Lumber / this._vassals.size), 0);
        if (sharePerVassal.Gold === 0 && sharePerVassal.Metal === 0 && sharePerVassal.Lumber === 0) return;

        let totalGiven = createResourcesAmount(0, 0, 0, 0);
        for (const vassal of this.vassals) {
            const payment = createResourcesAmount(
                Math.max(0, Math.min(sharePerVassal.Gold, FfaParticipant.VASSAL_RESOURCE_LIMIT - vassal.settlement.Resources.Gold)),
                Math.max(0, Math.min(sharePerVassal.Metal, FfaParticipant.VASSAL_RESOURCE_LIMIT - vassal.settlement.Resources.Metal)),
                Math.max(0, Math.min(sharePerVassal.Lumber, FfaParticipant.VASSAL_RESOURCE_LIMIT - vassal.settlement.Resources.Lumber)),
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

    public shareSpoils(defeated: FfaParticipant, takenPercentage: number): void {
        const distributedPower = defeated.powerPoints * takenPercentage;
        defeated.powerPoints -= distributedPower;

        let totalDamage = this.getMembers().reduce((sum, member) => sum + Math.max(1, member.damageDealtTo.get(defeated.id) || 0), 0);

        for (const member of this.getMembers()) {
            const damageShare = Math.max(1, member.damageDealtTo.get(defeated.id) || 0) / totalDamage;
            const gain = distributedPower * damageShare;
            member.powerPoints += gain;
            const msg = createGameMessageWithSound(`За победу над ${defeated.name} вам начислено ${Math.round(gain)} очков власти.`, member.settlement.SettlementColor);
            member.settlement.Messages.AddMessage(msg);
            member.damageDealtTo.set(defeated.id, 0);
        }
    }

    public declareWarOn(enemyTeam: Team): void {
        if (this.enemyTeam) {
            return; // Уже в состоянии войны
        }

        this.enemyTeam = enemyTeam;
        enemyTeam.enemyTeam = this;

        for (const member of this.getMembers()) {
            for (const enemyMember of enemyTeam.getMembers()) {
                member.settlement.Diplomacy.DeclareWar(enemyMember.settlement);
                enemyMember.settlement.Diplomacy.DeclareWar(member.settlement);
            }
        }
    }

    public makePeace(): void {
        if (!this.enemyTeam) {
            return;
        }

        for (const member of this.getMembers()) {
            for (const enemyMember of this.enemyTeam.getMembers()) {
                member.settlement.Diplomacy.DeclarePeace(enemyMember.settlement);
                enemyMember.settlement.Diplomacy.DeclarePeace(member.settlement);
            }
        }

        this.enemyTeam.enemyTeam = null;
        this.enemyTeam = null;
    }

    private updateDiplomacyOnJoin(newMember: FfaParticipant): void {
        // Союз с членами своей команды
        for (const member of this.getMembers()) {
            if (newMember.id !== member.id) {
                newMember.settlement.Diplomacy.DeclareAlliance(member.settlement);
                member.settlement.Diplomacy.DeclareAlliance(newMember.settlement);
            }
        }

        // Война с вражеской командой
        if (this.enemyTeam) {
            for (const enemyMember of this.enemyTeam.getMembers()) {
                newMember.settlement.Diplomacy.DeclareWar(enemyMember.settlement);
                enemyMember.settlement.Diplomacy.DeclareWar(newMember.settlement);
            }
        }
    }

    public getPower(): number {
        return this.getMembers().reduce((sum, member) => sum + member.getCurrentPower(), 0);
    }
}