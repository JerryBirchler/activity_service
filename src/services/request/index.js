'use strict';

const
    Router = require('koa-router'),
    bodyParser = require('koa-bodyparser'),
    Store = require('./store'),
    log4js = require('log4js'),
    util = require('util'),
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

        router.post('/', parser, this.save.bind(this));
        router.get('/:uuid', this.getById.bind(this));
        return router.routes();
    }

    async save(ctx) {
        logger.info("saving a request");

        ctx.assert(ctx.request.body.uuid, 400, "'uuid' field is missing.");
        ctx.assert(ctx.request.body.method, 400, "'method' field is missing.");
        ctx.assert(ctx.request.body.url, 400, "'url' field is missing.");
        ctx.assert(ctx.request.body.task_id, 400, "'task_id' field is missing.");

        logger.debug(`Saving new request: ${util.inspect(ctx.response.body)}`);

        // Save and return it
        ctx.response.body = await this._store.new(ctx.request.body);
        ctx.status = 201;
        return ctx.response.body;
    }


    async getById(ctx) {
        logger.info("getting a request");
        const result = await this._store.getByuuid(ctx.params.uuid);
        ctx.response.body = result;
        return ctx.response.body;
    }
}

module.exports = {
    new: () => new ActivityService(Store.new())
};