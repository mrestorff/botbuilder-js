/**
 * @module botbuilder-planning
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
import { 
    TurnContext, BotTelemetryClient, NullTelemetryClient, Storage, ActivityTypes, 
    RecognizerResult, Activity, StoreItems
} from 'botbuilder-core';
import { 
    Dialog, DialogInstance, DialogReason, DialogTurnResult, DialogTurnStatus, DialogEvent,
    DialogContext, DialogState, DialogSet, StateMap, DialogConsultation, DialogConsultationDesire
} from 'botbuilder-dialogs';
import { 
    PlanningEventNames, PlanningContext, PlanningState, PlanChangeList, PlanChangeType 
} from './planningContext';
import { PlanningRule } from './rules';
import { Recognizer } from './recognizers';
import { PlanningAdapter } from './internal/planningAdapter';

export interface StoredBotState {
    userState: { 
        eTag?: string; 
    };
    conversationState: {
        eTag?: string;
        _dialogs?: DialogState;
        _lastAccess?: string;
    };
}

export interface BotTurnResult {
    turnResult: DialogTurnResult;
    activities?: Partial<Activity>[];
    newState?: StoredBotState;
}

export interface BotStateStorageKeys {
    userState: string;
    conversationState: string;
}

export class PlanningDialog<O extends object = {}> extends Dialog<O> {
    private readonly dialogs: DialogSet = new DialogSet();
    private readonly runDialogSet: DialogSet = new DialogSet(); // Used by the run() method
    private installedDependencies = false;

    public readonly rules: PlanningRule[] = [];

    /**
     * (Optional) number of milliseconds to expire the bots state after. 
     */
    public expireAfter?: number;

    /**
     * (Optional) storage provider that will be used to read and write the bots state..
     */
    public storage: Storage;

    /**
     * (Optional) recognizer used to analyze any message utterances.
     */
    public recognizer: Recognizer;

    /**
     * Creates a new `PlanningDialog` instance.
     * @param dialogId (Optional) unique ID of the component within its parents dialog set.
     */
    constructor(dialogId?: string) {
        super(dialogId);
        this.runDialogSet.add(this);
    }
    
    /**
     * Set the telemetry client, and also apply it to all child dialogs.
     * Future dialogs added to the component will also inherit this client.
     */
    public set telemetryClient(client: BotTelemetryClient) {
        this._telemetryClient = client ? client : new NullTelemetryClient();
        this.dialogs.telemetryClient = client;
    }

     /**
     * Get the current telemetry client.
     */
    public get telemetryClient(): BotTelemetryClient {
        return this._telemetryClient;
    }
    /**
     * Fluent method for assigning a recognizer to the dialog.
     * @param recognizer The recognizer to assign to the dialog.
     */
    public setRecognizer(recognizer: Recognizer): this {
        this.recognizer = recognizer;
        return this;
    }

    public addDialog(...dialogs: Dialog[]): this {
        dialogs.forEach((dialog) => this.dialogs.add(dialog));
        return this;
    }

    public addRule(...rules: PlanningRule[]): this {
        Array.prototype.push.apply(this.rules, rules);
        return this;
    }

    public findDialog(dialogId: string): Dialog | undefined {
        return this.dialogs.find(dialogId);
    }

    public async onTurn(context: TurnContext, state?: StoredBotState): Promise<BotTurnResult> {
        // Log start of turn
        console.log('------------:');

        // Load state from storage if needed
        let saveState = false;
        const keys = PlanningDialog.getStorageKeys(context);
        if (!state) {
            if (!this.storage) { throw new Error(`PlanningDialog: unable to load the bots state. PlanningDialog.storage not assigned.`) }
            state = await PlanningDialog.loadBotState(this.storage, keys);
            saveState = true;
        }

        // Clone state to preserve original state
        const newState = JSON.parse(JSON.stringify(state));

        // Check for expired conversation
        const now  = new Date();
        if (typeof this.expireAfter == 'number' && newState.conversationState._lastAccess) {
            const lastAccess = new Date(newState.conversationState._lastAccess);
            if (now.getTime() - lastAccess.getTime() >= this.expireAfter) {
                // Clear conversation state
                state.conversationState = { eTag: newState.conversationState.eTag }
            }
        }
        newState.conversationState._lastAccess = now.toISOString();

        // Ensure dialog stack populated
        if (!newState.conversationState._dialogs) { 
            newState.conversationState._dialogs = { dialogStack: [] }
        }

        // Create DialogContext
        const userState = new StateMap(newState.userState);
        const conversationState = new StateMap(newState.conversationState);
        const dc = new DialogContext(this.runDialogSet, context, newState.conversationState._dialogs, userState, conversationState);

        // Execute component
        let result = await dc.continueDialog();
        if (result.status == DialogTurnStatus.empty) {
            result = await dc.beginDialog(this.id);
        }

        // Save state if loaded from storage
        if (saveState) {
            await PlanningDialog.saveBotState(this.storage, keys, newState, state, '*');
            return { turnResult: result };
        } else {
            return { turnResult: result, newState: newState };
        }
    }

    public async run(activity: Partial<Activity>, state?: StoredBotState): Promise<BotTurnResult> {
        // Initialize context object
        const adapter = new PlanningAdapter();
        const context = new TurnContext(adapter, activity);
        const result = await this.onTurn(context, state);
        result.activities = adapter.activities;
        return result;
    }

    protected onInstallDependencies(): void {
        // Install each rules steps
        this.rules.forEach((rule) => {
            rule.steps.forEach((step) => this.dialogs.add(step));
        });
    }

    //---------------------------------------------------------------------------------------------
    // Base Dialog Overrides
    //---------------------------------------------------------------------------------------------

    protected onComputeID(): string {
        return `planning(${this.bindingPath()})`;
    }
   
    public async beginDialog(dc: DialogContext, options?: O): Promise<DialogTurnResult> {
        const state: PlanningState<O> = dc.activeDialog.state;

        try {
            // Install dependencies on first access
            if (!this.installedDependencies) {
                this.installedDependencies = true;
                this.onInstallDependencies();
            }
            
            // Persist options to dialog state
            state.options = options || {} as O;

            // Initialize 'result' with any initial value
            if (state.options.hasOwnProperty('value')) {
                const value = options['value'];
                const clone = Array.isArray(value) || typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
                state.result = clone;
            }

            // Create a new planning context
            const planning = PlanningContext.create(dc, state);

            // Evaluate rules and queue up plan changes
            await this.evaluateRules(planning, { name: PlanningEventNames.beginDialog, value: options, bubble: false });
            
            // Run plan
            return await this.continuePlan(planning);
        } catch (err) {
            return await dc.cancelAllDialogs('error', { message: err.message, stack: err.stack });
        }
    }

    public async consultDialog(dc: DialogContext): Promise<DialogConsultation> {
        try {
            // Create a new planning context
            const state: PlanningState<O> = dc.activeDialog.state;
            const planning = PlanningContext.create(dc, state);

            // First consult plan
            let consultation = await this.consultPlan(planning);
            if (!consultation || consultation.desire != DialogConsultationDesire.shouldProcess) {
                // Next evaluate rules
                const changesQueued = await this.evaluateRules(planning, { name: PlanningEventNames.consultDialog, value: undefined, bubble: false });
                if (changesQueued) {
                    consultation = {
                        desire: DialogConsultationDesire.shouldProcess,
                        processor: (dc) => this.continuePlan(planning)
                    };
                }

                // Fallback to just continuing the plan
                if (!consultation) {
                    consultation = {
                        desire: DialogConsultationDesire.canProcess,
                        processor: (dc) => this.continuePlan(planning)
                    };
                }
            } 

            return consultation;
        } catch (err) {
            return {
                desire: DialogConsultationDesire.shouldProcess,
                processor: (dc) => dc.cancelAllDialogs('error', { message: err.message, stack: err.stack })
            };
        }
    }

    public async onDialogEvent(dc: DialogContext, event: DialogEvent): Promise<boolean> {
        // Create a new planning context
        const state: PlanningState<O> = dc.activeDialog.state;
        const planning = PlanningContext.create(dc, state);

        // Evaluate rules and queue up any potential changes 
        return await this.evaluateRules(planning, event);
    }

    public async resumeDialog(dc: DialogContext, reason: DialogReason, result?: any): Promise<DialogTurnResult> {
        // Containers are typically leaf nodes on the stack but the dev is free to push other dialogs
        // on top of the stack which will result in the container receiving an unexpected call to
        // resumeDialog() when the pushed on dialog ends.
        // To avoid the container prematurely ending we need to implement this method and simply
        // ask our inner dialog stack to re-prompt.
        await this.repromptDialog(dc.context, dc.activeDialog);

        return Dialog.EndOfTurn;
    }

    public async repromptDialog(context: TurnContext, instance: DialogInstance): Promise<void> {
        // Forward to current sequence step
        const state = instance.state as PlanningState<O>;
        const plan = state.plan;
        if (plan && plan.steps.length > 0) {
            // We need to mockup a DialogContext so that we can call repromptDialog() for the active step 
            const stepDC: DialogContext = new DialogContext(this.dialogs, context, plan.steps[0], new StateMap({}), new StateMap({}));
            await stepDC.repromptDialog();
        }
    }
 
    //---------------------------------------------------------------------------------------------
    // Rule Processing
    //---------------------------------------------------------------------------------------------

    protected async evaluateRules(planning: PlanningContext, event: DialogEvent): Promise<boolean> {
        let handled = false;
        switch (event.name) {
            case PlanningEventNames.beginDialog:
            case PlanningEventNames.consultDialog:
                // Emit event
                handled = await this.queueFirstMatch(planning, event);
                if (!handled) {
                    // Dispatch activityReceived event
                    handled = await this.evaluateRules(planning, { name: PlanningEventNames.activityReceived, value: undefined, bubble: false });
                }
                break;
            case PlanningEventNames.activityReceived:
                // Emit event
                handled = await this.queueFirstMatch(planning, event);
                if (!handled) {
                    const activity = planning.context.activity;
                    if (activity.type === ActivityTypes.Message) {
                        // Recognize utterance
                        const recognized = await this.onRecognize(planning.context);
    
                        // Dispatch utteranceRecognized event
                        handled = await this.evaluateRules(planning, { name: PlanningEventNames.utteranceRecognized, value: recognized, bubble: false });
                    } else if (activity.type === ActivityTypes.Event) {
                        // Dispatch named event that was received
                        handled = await this.evaluateRules(planning, { name: activity.name, value: activity.value, bubble: false });
                    }
                }
                break;
            case PlanningEventNames.utteranceRecognized:
                // Emit utteranceRecognized event
                handled = await this.queueBestMatches(planning, event);
                if (!handled) {
                    // Dispatch fallback event
                    handled = await this.evaluateRules(planning, { name: PlanningEventNames.fallback, value: event.value, bubble: false });
                }
                break;
            case PlanningEventNames.fallback:
                if (!planning.hasPlans) {
                    // Emit fallback event
                    handled = await this.queueFirstMatch(planning, event);
                }
                break;
            default:
                // Emit event received
                handled = await this.queueFirstMatch(planning, event);
            }

        return handled;
    }

    protected async onRecognize(context: TurnContext): Promise<RecognizerResult> {
        const noneIntent: RecognizerResult = {
            text: context.activity.text || '',
            intents: { 'None': { score: 0.0 } },
            entities: {}
        };
        return this.recognizer ? await this.recognizer.recognize(context) : noneIntent;
    }

    private async queueFirstMatch(planning: PlanningContext, event: DialogEvent): Promise<boolean> {
        for (let i = 0; i < this.rules.length; i++) {
            const changes = await this.rules[i].evaluate(planning, event);
            if (changes && changes.length > 0) {
                planning.queueChanges(changes[0]);
                return true;
            }
        }

        return false;
    }

    private async queueBestMatches(planning: PlanningContext, event: DialogEvent): Promise<boolean> {
        // Get list of proposed changes
        const allChanges: PlanChangeList[] = [];
        for (let i = 0; i < this.rules.length; i++) {
            const changes = await this.rules[i].evaluate(planning, event);
            if (changes) { changes.forEach((change) => allChanges.push(change)) } 
        }

        // Find changes with most coverage
        const appliedChanges: { index: number; change: PlanChangeList; }[] = [];
        if (allChanges.length > 0) {
            while (true) {
                // Find the change that has the most intents and entities covered.
                const index = this.findBestChange(allChanges);
                if (index >= 0) {
                    // Add change to apply list
                    const change = allChanges[index];
                    appliedChanges.push({ index: index, change: change });

                    // Remove applied changes
                    allChanges.splice(index, 1);

                    // Remove changes with overlapping intents.
                    for (let i = allChanges.length - 1; i >= 0; i--) {
                        if (this.intentsOverlap(change, allChanges[i])) {
                            allChanges.splice(i, 1);
                        }
                    }
                } else {
                    // Exit loop
                    break;
                }
            }
        }

        // Queue changes
        if (appliedChanges.length > 0) {
            const sorted = appliedChanges.sort((a, b) => a.index - b.index);
            if (sorted.length > 1) {
                // Look for the first change that starts a new plan 
                for (let i = 0; i < sorted.length; i++) {
                    const changeType = sorted[i].change.changeType;
                    if (changeType == PlanChangeType.newPlan || changeType == PlanChangeType.replacePlan) {
                        // Queue change and remove from list
                        planning.queueChanges(sorted[i].change);
                        sorted.splice(i, 1);
                        break;
                    }
                    
                }

                // Queue additional changes
                // - Additional newPlan or replacePlan steps will be changed to a `doStepsLater`
                //   changeType so that they're appended to teh new plan.
                for (let i = 0; i < sorted.length; i++) {
                    const change = sorted[i].change;
                    switch (change.changeType) {
                        case PlanChangeType.doSteps:
                        case PlanChangeType.doStepsBeforeTags:
                        case PlanChangeType.doStepsLater:
                            planning.queueChanges(change);
                            break;
                        case PlanChangeType.newPlan:
                        case PlanChangeType.replacePlan:
                            change.changeType = PlanChangeType.doStepsLater;
                            planning.queueChanges(change);
                            break;
                    }
                }
            } else {
                // Just queue the change
                planning.queueChanges(sorted[0].change);
            }
            
            return true;
        } else {
            return false;
        }
    }

    private findBestChange(changes: PlanChangeList[]): number {
        let top: PlanChangeList;
        let topIndex = -1;
        for (let i = 0; i < changes.length; i++) {
            const change = changes[i];
            let better = false;
            if (!top) {
                better = true;
            } else {
                const topIntents = top.intentsMatched || [];
                const intents = change.intentsMatched || [];
                if (intents.length > topIntents.length) {
                    better = true;
                } else if (intents.length == topIntents.length) {
                    const topEntities = top.entitiesMatched || [];
                    const entities = change.entitiesMatched || [];
                    better = entities.length > topEntities.length;
                }
            }

            if (better) {
                top = change;
                topIndex = i;
            }
        }
        return topIndex;
    }

    private intentsOverlap(c1: PlanChangeList, c2: PlanChangeList): boolean {
        const i1 = c1.intentsMatched || [];
        const i2 = c2.intentsMatched || [];
        if (i2.length > 0 && i1.length > 0) {
            for (let i = 0; i < i2.length; i++) {
                if (i1.indexOf(i2[i]) >= 0) {
                    return true;
                }
            }
        } else if (i2.length == i1.length) {
            return true;
        }
        return false;
    }

    //---------------------------------------------------------------------------------------------
    // Plan Execution
    //---------------------------------------------------------------------------------------------

    protected async consultPlan(planning: PlanningContext): Promise<DialogConsultation> {
        // Apply any queued up changes
        await planning.applyChanges();

        // Get a unique instance ID for the current stack entry.
        // - We need to do this because things like cancellation can cause us to be removed
        //   from the stack and we want to detect this so we can stop processing steps.
        const instanceId = this.getUniqueInstanceId(planning);

        // Delegate consultation to any active planning step
        const step = PlanningContext.createForStep(planning, this.dialogs);
        const consultation = step ? await step.consultDialog() : undefined;
        return {
            desire: consultation ? consultation.desire : DialogConsultationDesire.canProcess,
            processor: async (dc) => {
                if (step) {
                    // Continue current step
                    console.log(`running step: ${step.plan.steps[0].dialogId}`);
                    let result = consultation ? await consultation.processor(step) : { status: DialogTurnStatus.empty };
                    if (result.status == DialogTurnStatus.empty && !result.parentEnded) {
                        const nextStep = step.plan.steps[0];
                        result = await step.beginDialog(nextStep.dialogId, nextStep.options);
                    }

                    // Process step results
                    if (!result.parentEnded && this.getUniqueInstanceId(planning) === instanceId) {
                        // Is step waiting?
                        if (result.status === DialogTurnStatus.waiting) {
                            return result;
                        }

                        // End the current step
                        // - If we intercepted a cancellation, the plan should get updated with 
                        //   additional steps when we continue.
                        await planning.endStep();

                        // Continue plan execution
                        const plan = planning.plan;
                        if (plan && plan.steps.length > 0 && plan.steps[0].dialogStack && plan.steps[0].dialogStack.length > 0) {
                            // Tell step to re-prompt
                            await this.repromptDialog(dc.context, dc.activeDialog);
                            return { status: DialogTurnStatus.waiting };
                        } else {
                            return await this.continuePlan(planning);
                        }
                    } else {
                        // Remove parent ended flag and return result.
                        if (result.parentEnded) { delete result.parentEnded };
                        return result;
                    }
                } else if (planning.activeDialog) {
                    return await this.onEndOfPlan(planning);
                }
            }
        }
    }

    protected async continuePlan(planning: PlanningContext): Promise<DialogTurnResult> {
        // Consult plan and execute returned processor
        try {
            const consultation = await this.consultPlan(planning);
            return await consultation.processor(planning);
        } catch (err) {
            return await planning.cancelAllDialogs('error', { message: err.message, stack: err.stack });
        }
    }

    protected async onEndOfPlan(planning: PlanningContext): Promise<DialogTurnResult> {
        // End dialog and return default result
        const state: PlanningState<O> = planning.activeDialog.state;
        return await planning.endDialog(state.result);
    }

    private getUniqueInstanceId(dc: DialogContext): string {
        return dc.stack.length > 0 ? `${dc.stack.length}:${dc.activeDialog.id}` : '';
    }

    //---------------------------------------------------------------------------------------------
    // State loading
    //---------------------------------------------------------------------------------------------

    static async loadBotState(storage: Storage, keys: BotStateStorageKeys): Promise<StoredBotState> {
        const data = await storage.read([keys.userState, keys.conversationState]);
        return {
            userState: data[keys.userState] || {},
            conversationState: data[keys.conversationState] || {}
        };
    }

    static async saveBotState(storage: Storage, keys: BotStateStorageKeys, newState: StoredBotState, oldState?: StoredBotState, eTag?: string): Promise<void> {
        // Check for state changes
        let save = false;
        const changes: StoreItems = {};
        if (oldState) {
            if (JSON.stringify(newState.userState) != JSON.stringify(oldState.userState)) {
                if (eTag) { newState.userState.eTag = eTag }
                changes[keys.userState] = newState.userState;
                save = true; 
            }
            if (JSON.stringify(newState.conversationState) != JSON.stringify(oldState.conversationState)) {
                if (eTag) { newState.conversationState.eTag = eTag }
                changes[keys.conversationState] = newState.conversationState;
                save = true;
            }
        } else {
            if (eTag) {
                newState.userState.eTag = eTag;
                newState.conversationState.eTag = eTag;
            }
            changes[keys.userState] = newState.userState;
            changes[keys.conversationState] = newState.conversationState;
            save = true;
        }

        // Save changes
        if (save) {
            await storage.write(changes);
        }
    }

    static getStorageKeys(context: TurnContext): BotStateStorageKeys {
        // Get channel, user, and conversation ID's
        const activity = context.activity;
        const channelId: string = activity.channelId;
        let userId: string = activity.from && activity.from.id ? activity.from.id : undefined;
        const conversationId: string = activity.conversation && activity.conversation.id ? activity.conversation.id : undefined;

        // Patch User ID if needed
        if (activity.type == ActivityTypes.ConversationUpdate) {
            const users = (activity.membersAdded || activity.membersRemoved || []).filter((u) => u.id != activity.recipient.id);
            const found = userId ? users.filter((u) => u.id == userId) : [];
            if (found.length == 0 && users.length > 0) {
                userId = users[0].id
            }
        } 

        // Verify ID's found
        if (!userId) { throw new Error(`PlanningDialog: unable to load the bots state. The users ID couldn't be found.`) }
        if (!conversationId) { throw new Error(`PlanningDialog: unable to load the bots state. The conversations ID couldn't be found.`) }

        // Return storage keys
        return {
            userState: `${channelId}/users/${userId}`,
            conversationState: `${channelId}/conversations/${conversationId}`
        };
    }
}
