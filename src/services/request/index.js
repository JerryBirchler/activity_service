'use strict';

const
    Router = require('koa-router'),
    bodyParser = require('koa-bodyparser'),
    config = require('config'),
    Store = require('./store'),
    log4js = require('log4js'),
    util = require('util'),
    validate = require('uuid-validate'),
    _ = require('lodash');

const logger = log4js.getLogger('request');

class RequestService {
    constructor(store) {
        this._store = store;
    }

    async init() {
        await this._store.init(config);        
        const routerOptions = { prefix: "/request" };
        const parser = bodyParser();
        const router = new Router(routerOptions);
        logger.info('initializing request service...');

        router.get('/', this.get.bind(this));
        router.get('/:uuid', this.getByuuid.bind(this));
        router.post('/', parser, this.save.bind(this));
        router.put('/:uuid', this.update.bind(this));
        router.patch('/:action', this.patchDataProperties.bind(this));
        return router.routes();
    }

    async get(ctx) {
        logger.debug("get");
        ctx.assert(_.keysIn(ctx.query).length > 0, 400, "Must contain at least one query string parameter"); 
        const result = await this._store.get(ctx.query);
        ctx.response.body = result;
        return ctx.response.body;
    }

    async getByuuid(ctx) {
        logger.debug("getByuuid");
        ctx.assert(ctx.params.uuid, 400, "'uuid' is not a valid UUID.");
        ctx.assert(validate(ctx.params.uuid), 400, "'uuid' is not a valid UUID.");
        const result = await this._store.getByuuid(ctx.params.uuid);
        ctx.response.body = result;
        ctx.status = 200;
        return ctx.response.body;
    }

    async save(ctx) {        
        logger.debug("save");

        ctx.assert(ctx.request.body.uuid, 400, "'uuid' field is missing.");
        ctx.assert(ctx.request.body.method, 400, "'method' field is missing.");
        ctx.assert(ctx.request.body.url, 400, "'url' field is missing.");
        ctx.assert(ctx.request.body.task_id, 400, "'task_id' field is missing.");

        // Save and return it
        const response = await this._store.new(ctx.request.body);
        if (response.status / 100 !== 2) {
            logger.info(`save uuid: [${ctx.request.body.uuid}] status: [${response.status}], message: [${response.message}]`);
        } else {
            logger.info(`save uuid: [${ctx.request.body.uuid}] status: [${response.status}]`);
        }
        ctx.response.body = response.message;
        ctx.status = response.status;
        return ctx.response.body;
    }

    async update(ctx) {
        logger.debug("update");

        ctx.assert(ctx.params.uuid, 400, "'uuid' is not a valid UUID.");
        ctx.assert(validate(ctx.params.uuid), 400, "'uuid' is not a valid UUID.");

        logger.debug(`Uodate existing request: ${util.inspect(ctx.response.body)}`);

        // Save and return it
        const response = await this._store.update(ctx.request.body, ctx.params.uuid);

        if (response.status / 100 !== 2) {
            logger.info(`update uuid: [${ctx.request.body.uuid}] status: [${response.status}], message: [${response.message}]`);
        } else {
            logger.info(`update uuid: [${ctx.request.body.uuid}] status: [${response.status}]`);
        }

        ctx.response.body = response.message;
        ctx.status = response.status;
        return ctx.response.body;
    }

    async patchDataProperties(ctx) {
        logger.debug("patch data properties");

        ctx.assert(ctx.params.action, 400, "'action' must be provided");
        ctx.assert(ctx.params.action === "drop", 400, "'action' must be 'drop'");
        ctx.assert(_.keysIn(ctx.query).length > 0, 400, "Must contain at least one query string parameter"); 
        const response = await this._store.dropProperties(ctx.request.body, ctx.query);
        ctx.response.body = response.message;
        ctx.status = response.status;
        return ctx.response.body;
    }
}

module.exports = {
    new: () => new RequestService(Store.new())
};