'use strict';

const
    Router = require('koa-router'),
    bodyParser = require('koa-bodyparser'),
    Store = require('./store'),
    log4js = require('log4js'),
    util = require('util'),
    validate = require('uuid-validate'),
    _ = require('lodash');

const logger = log4js.getLogger('Request');

class ActivityService {
    constructor(store) {
        this._store = store;
    }

    async init() {
        await this._store.init();        
        const routerOptions = { prefix: "/request" };
        const parser = bodyParser();
        const router = new Router(routerOptions);
        logger.info('initializing request service...');

        router.get('/', this.getRequests.bind(this));
        router.get('/:uuid', this.getRequestByuuId.bind(this));
        router.post('/', parser, this.saveRequest.bind(this));
        router.put('/:uuid', this.updateRequest.bind(this));
        router.patch('/:action', this.patchRequestProperties.bind(this));
        return router.routes();
    }

    async getRequests(ctx) {
        logger.debug("getting requests");
        ctx.assert(_.keysIn(ctx.query).length > 0, 400, "Must contain at least one query string parameter"); 
        const result = await this._store.get(ctx.query);
        ctx.response.body = result;
        return ctx.response.body;
    }

    async getRequestByuuId(ctx) {
        logger.debug("getting a request");
        ctx.assert(ctx.params.uuid, 400, "'uuid' is not a valid UUID.");
        ctx.assert(validate(ctx.params.uuid), 400, "'uuid' is not a valid UUID.");
        const result = await this._store.getByuuid(ctx.params.uuid);
        ctx.response.body = result;
        ctx.status = 200;
        return ctx.response.body;
    }

    async saveRequest(ctx) {
        logger.debug("saving a request");

        ctx.assert(ctx.request.body.uuid, 400, "'uuid' field is missing.");
        ctx.assert(ctx.request.body.method, 400, "'method' field is missing.");
        ctx.assert(ctx.request.body.url, 400, "'url' field is missing.");
        ctx.assert(ctx.request.body.task_id, 400, "'task_id' field is missing.");

        logger.debug(`Saving new request: ${util.inspect(ctx.response.body)}`);

        // Save and return it
        const response = await this._store.new(ctx.request.body);
        logger.debug(`response: ${response}`);
        ctx.response.body = response.message;
        ctx.status = response.status;
        return ctx.response.body;
    }

    async updateRequest(ctx) {
        logger.debug("update a request");

        ctx.assert(ctx.params.uuid, 400, "'uuid' is not a valid UUID.");
        ctx.assert(validate(ctx.params.uuid), 400, "'uuid' is not a valid UUID.");

        logger.debug(`Uodate existing request: ${util.inspect(ctx.response.body)}`);

        // Save and return it
        const response = await this._store.update(ctx.request.body, ctx.params.uuid);
        logger.debug(`response: ${response}`);
        ctx.response.body = response.message;
        ctx.status = response.status;
        return ctx.response.body;
    }

    async patchRequestProperties(ctx) {
        logger.debug("patch request properties");

        ctx.assert(ctx.params.action, 400, "'action' must be provided");
        ctx.assert(ctx.params.action === "drop", 400, "'action' must be 'drop'");
        ctx.assert(_.keysIn(ctx.query).length > 0, 400, "Must contain at least one query string parameter"); 
        const response = await this._store.dropProperties(ctx.request.body, ctx.query);

        logger.debug(`response: [${util.inspect(response)}]`);

        ctx.response.body = response.message;
        ctx.status = response.status;
        return ctx.response.body;
    }
}


module.exports = {
    new: () => new ActivityService(Store.new())
};