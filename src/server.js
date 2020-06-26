// Default environment
process.env.NODE_ENV = process.env.NODE_ENV || 'local-dev';

const
    koa = require('koa'),
    config = require('config'),
    log4js = require('log4js'),
    bodyParser = require('koa-bodyparser'),
    http = require('http');

// Configure logging
log4js.configure(config.log4js);

const logger = log4js.getLogger('server');

async function start(options) {
    let defaultOptions = { appStarted: undefined, port: config.server.port };
    options = options || defaultOptions;
    options.port = options.port || config.server.port;

    logger.info('initializing models...');

    // Load data models
    await require('./models').init();

    // Configure middleware
    const app = new koa();
    app.use(bodyParser(config.bodyParser));
    app.on('error', (err, ctx) => {
        if (!err.expose){
            logger.error(ctx.originalUrl, err);
        }
    });

    logger.info('initializing services...');
    // Load services
    await require('./services').init(app);

    // Start the server
    http.createServer(app.callback())
        .listen(options.port, () => {
            logger.info(`Listening on port ${options.port}...`);
            if (options.appStarted) {
                logger.info('calling appStarted');
                options.appStarted();
            }
        });
}

if (!module.parent) {
    start().catch((e) => {
        logger.error(e);
        log4js.shutdown(function() { process.exit(1); });
        process.exit(-1);
    });
}

module.exports = {
    start: start
};
