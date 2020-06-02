'use strict';

const
    config = require('config'),
    Promise = require('bluebird'),
    fs = Promise.promisifyAll(require('fs')),
    path = require('path'),
    _ = require('lodash'),
    Router = require('koa-router'),
    koaSwagger = require('koa2-swagger-ui'),
    util = require('util'),
    log4js = require('log4js');

// Configure logging
const logger = log4js.getLogger('server');

//config.authentication.logFactory = log4js;

async function init(app){
    logger.info('setting up documentation routes...');
    // setting up documentation.
    const servicesRootDirectory = __dirname;
    const routerOptions = {
        prefix: config.server.prefix + '/v1'
    };
    const documentationRouter = new Router(routerOptions);
    documentationRouter.get('/docs/spec', async (ctx) => {
        ctx.body = fs.createReadStream(path.join(servicesRootDirectory, 'v1.swagger.json'));
    });
    const swaggerMiddlewareOptions = {
        routePrefix: `${routerOptions.prefix}/docs`,
        swaggerOptions: {
            url: `${routerOptions.prefix}/docs/spec`
        }
    };
    const swaggerMiddleware = koaSwagger(swaggerMiddlewareOptions);
    app.use(swaggerMiddleware);
    app.use(documentationRouter.routes());
    logger.info('setting up services...');

    // hooking up services.
    const serviceDirectories = await fs.readdirAsync(servicesRootDirectory);
    if (!serviceDirectories) {
        logger.warn('no services were found.');
        return;
    }
    const services = serviceDirectories.map(
        (directoryName) => {
            return {
                path: path.join(servicesRootDirectory, directoryName),
                name: directoryName
            }
        }).filter((candidate) => fs.lstatSync(candidate.path).isDirectory());

    const servicesRouter = new Router(routerOptions);
    const unauthRouter = new Router(routerOptions);

    for (let i = 0; i < services.length; i++) {
        const s = services[i];
        logger.info(`instantiating service ${s.path}...`);
        const service = require(s.path).new();
        const routes = await service.init(app);
        servicesRouter.use(routes);
    }

    app.use(unauthRouter.routes());
    app.use(servicesRouter.routes());
}

module.exports = {
    init: init
};
