/**************************************************************************
 *  (C) Copyright ModusBox Inc. 2019 - All rights reserved.               *
 *                                                                        *
 *  This file is made available under the terms of the license agreement  *
 *  specified in the corresponding source code repository.                *
 *                                                                        *
 *  ORIGINAL AUTHOR:                                                      *
 *       Yevhen Kyriukha - yevhen.kyriukha@modusbox.com                   *
 **************************************************************************/

'use strict';

const util = require('util');
const uuidv4 = require('uuid/v4');
const StateMachine = require('javascript-state-machine');
const { MojaloopRequests, Errors } = require('@mojaloop/sdk-standard-components');
const { BackendError } = require('./common');

const stateEnum = {
    'ERROR_OCCURED': 'ERROR_OCCURED',
    'COMPLETED': 'COMPLETED',
};


/**
 *  Models the state machine and operations required for performing an outbound transfer
 */
class AccountsModel {
    constructor(config) {
        this.cache = config.cache;
        this.logger = config.logger;
        this.requestProcessingTimeoutSeconds = config.requestProcessingTimeoutSeconds;
        this.dfspId = config.dfspId;

        this.requests = new MojaloopRequests({
            logger: this.logger,
            peerEndpoint: config.alsEndpoint,
            dfspId: config.dfspId,
            tls: config.tls,
            jwsSign: config.jwsSign,
            jwsSigningKey: config.jwsSigningKey,
            wso2Auth: config.wso2Auth
        });
    }


    /**
     * Initializes the internal state machine object
     */
    _initStateMachine (initState) {
        this.stateMachine = new StateMachine({
            init: initState,
            transitions: [
                { name: 'createAccounts', from: 'start', to: 'succeeded' },
                { name: 'error', from: '*', to: 'errored' },
            ],
            methods: {
                onTransition: this._handleTransition.bind(this),
                onAfterTransition: this._afterTransition.bind(this),
                onPendingTransition: (transition, from, to) => {
                    // allow transitions to 'error' state while other transitions are in progress
                    if(transition !== 'error') {
                        throw new Error(`Transition requested while another transition is in progress: ${transition} from: ${from} to: ${to}`);
                    }
                }
            }
        });

        return this.stateMachine[initState];
    }


    /**
     * Updates the internal state representation to reflect that of the state machine itself
     */
    _afterTransition() {
        this.data.currentState = this.stateMachine.state;
    }


    /**
     * Initializes the accounts model
     *
     * @param data {object} - The outbound API POST /accounts request body
     */
    async initialize(data) {
        this.data = data;

        // add a modelId if one is not present e.g. on first submission
        if(!this.data.hasOwnProperty('modelId')) {
            this.data.modelId = uuidv4();
        }

        // initialize the transfer state machine to its starting state
        if(!this.data.hasOwnProperty('currentState')) {
            this.data.currentState = 'start';
        }

        if(!this.data.hasOwnProperty('response')) {
            this.data.response = [];
        }

        this._initStateMachine(this.data.currentState);

        // set up a cache pub/sub subscriber
        this.subscriber = await this.cache.getClient();
    }


    /**
     * Handles state machine transitions
     */
    async _handleTransition(lifecycle, ...args) {
        this.logger.log(`Request ${this.data.requestId} is transitioning from ${lifecycle.from} to ${lifecycle.to} in response to ${lifecycle.transition}`);

        switch(lifecycle.transition) {
            case 'init':
                // init, just allow the fsm to start
                return;

            case 'createAccounts':
                // resolve the payee
                return this._createAccounts();

            case 'error':
                this.logger.push({ args }).log('State machine in errored state');
                this.data.lastError = args[0] ? args[0].message || 'unknown error' : 'unspecified error';
                break;

            default:
                this.logger.log(`Unhandled state transition for request ${this.data.requestId}`);
        }
    }

    async _executeCreateAccountsRequest(request) {
        return new Promise(async (resolve, reject) => {
            // set up a timeout for the request
            const timeout = setTimeout(() => {
                const err = new Error(`Timeout waiting for account creation request ${request.requestId}`);
                return reject(err);
            }, this.requestProcessingTimeoutSeconds * 1000);

            const requestKey = `${request.requestId}`;

            this.subscriber.subscribe(requestKey);
            this.subscriber.on('message', async (cn, msg) => {
                try {
                    let error;
                    let message = JSON.parse(msg);

                    if (message.type === 'accountsCreationErrorResponse') {
                        error = new BackendError(`Got an error response creating accounts: ${util.inspect(message)}`, 500);
                    } else if (message.type !== 'accountsCreationSuccessfulResponse') {
                        this.logger.push({ message }).log(
                            `Ignoring cache notification for request ${requestKey}. ` +
                            `Unknown message type ${message.type}.`
                        );
                        return;
                    }

                    // cancel the timeout handler
                    clearTimeout(timeout);

                    // stop listening for account creation response messages
                    this.subscriber.unsubscribe(requestKey, () => {
                        this.logger.log('Account creation subscriber unsubscribed');
                    });

                    if (error) {
                        return reject(error);
                    }

                    const response = message.data;
                    this.logger.push({ response }).log('Account creation response received');
                    return resolve(response);
                }
                catch(err) {
                    return reject(err);
                }
            });

            // now we have a timeout handler and a cache subscriber hooked up we can fire off
            // a POST /participants request to the switch
            try {
                const res = await this.requests.postParticipants(request);
                this.logger.push({ res }).log('Account creation request sent to ALS');
            }
            catch(err) {
                return reject(err);
            }
        });
    }


    async _createAccounts() {
        const requests = this._buildRequests();
        for await (let request of requests) {
            const response = await this._executeCreateAccountsRequest(request);
            this.data.response.push(...this._buildClientResponse(response));
        }
    }

    _buildClientResponse(response) {
        return response.partyList.map(party => ({
            idType: party.partyId.partyIdType,
            idValue: party.partyId.partyIdentifier,
            ...!response.currency && {
                error: {
                    statusCode: Errors.MojaloopApiErrorCodes.CLIENT_ERROR.code,
                    message: 'Provided currency not supported',
                }
            },
            ...party.errorInformation && {
                error: {
                    statusCode: party.errorInformation.errorCode,
                    message: party.errorInformation.errorDescription,
                },
            },
        }));
    }


    /**
     * Builds accounts creation requests payload from current state
     *
     * @returns {Array} - the account creation requests
     */
    _buildRequests() {
        const MAX_ITEMS_PER_REQUEST = 10000; // As per API Spec 6.2.2.2 (partyList field)

        const requests = [];
        for (let account of this.data.accounts) {
            let request = requests.find(req =>
                req.currency === account.currency && (req.partyList.length < MAX_ITEMS_PER_REQUEST));
            if (!request) {
                request = {
                    requestId: uuidv4(),
                    partyList: [],
                    currency: account.currency,
                };
                requests.push(request);
            }
            request.partyList.push({
                partyIdType: account.idType,
                partyIdentifier: account.idValue,
                fspId: this.dfspId,
            });
        }
        return requests;
    }

    /**
     * Returns an object representing the final state of the transfer suitable for the outbound API
     *
     * @returns {object} - Response representing the result of the transfer process
     */
    getResponse() {
        // we want to project some of our internal state into a more useful
        // representation to return to the SDK API consumer
        const resp = { ...this.data };

        switch(this.data.currentState) {
            case 'succeeded':
                resp.currentState = stateEnum.COMPLETED;
                break;

            case 'errored':
                resp.currentState = stateEnum.ERROR_OCCURED;
                break;

            default:
                this.logger.log(
                    `Account model response being returned from an unexpected state: ${this.data.currentState}. ` +
                    'Returning ERROR_OCCURED state'
                );
                resp.currentState = stateEnum.ERROR_OCCURED;
                break;
        }

        return resp;
    }


    /**
     * Persists the model state to cache for reinitialisation at a later point
     */
    async _save() {
        try {
            this.data.currentState = this.stateMachine.state;
            const res = await this.cache.set(`accountModel_${this.data.modelId}`, this.data);
            this.logger.push({ res }).log('Persisted account model in cache');
        }
        catch(err) {
            this.logger.push({ err }).log('Error saving account model');
            throw err;
        }
    }


    /**
     * Loads an accounts model from cache for resumption of the accounts management process
     *
     * @param modelId {string} - UUID of the model to load from cache
     */
    async load(modelId) {
        try {
            const data = await this.cache.get(`accountModel_${modelId}`);
            await this.initialize(data);
            this.logger.push({ cache: this.data }).log('Account model loaded from cached state');
        }
        catch(err) {
            this.logger.push({ err }).log('Error loading account model');
            throw err;
        }
    }


    /**
     * Unsubscribes the models subscriber from all subscriptions
     */
    async _unsubscribeAll() {
        return new Promise((resolve) => {
            this.subscriber.unsubscribe(() => {
                this.logger.log('Account model unsubscribed from all subscriptions');
                return resolve();
            });
        });
    }


    /**
     * Returns a promise that resolves when the state machine has reached a terminal state
     */
    async run() {
        try {
            // run transitions based on incoming state
            switch(this.data.currentState) {
                case 'start': {
                    await this.stateMachine.createAccounts();
                    const accounts = this.data.response;
                    const failCount = accounts.reduce((total, account) => account.errorInformation ? total + 1 : total);
                    const successCount = this.data.response.length - failCount;
                    this.logger.log(`Accounts created: ${successCount} succeeded, ${failCount} failed`);
                    break;
                }

                case 'succeeded':
                    // all steps complete so return
                    this.logger.log('Accounts creation completed');
                    await this._save();
                    return this.getResponse();

                case 'error':
                    // stopped in errored state
                    this.logger.log('State machine in errored state');
                    return this.getResponse();
            }

            // now call ourslves recursively to deal with the next transition
            this.logger.log(
                `Account model state machine transition completed in state: ${this.stateMachine.state}. ` +
                'Handling next transition.'
            );
            return await this.run();
        }
        catch(err) {
            this.logger.push({ err }).log('Error running account model');
            this.stateMachine.error(err);
            await this._unsubscribeAll();
            err.executionState = this.getResponse();
            throw err;
        }
    }
}


module.exports = AccountsModel;
